const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const prisma = require('../db');
const { hashPassword, verifyPassword, signAccessToken, generateRefreshToken, hashRefreshToken, refreshExpiryDate } = require('../auth');
const { requireAuth } = require('../middleware/auth');
const config = require('../config');
const mailer = require('../services/recoveryMailer');
const aiRuntime = require('../services/aiRuntime');
const mlLauncher = require('../services/mlLauncher');

const router = express.Router();
const authLimiter = rateLimit({windowMs:15*60*1000,max:Number(process.env.PORTAL_AUTH_RATE_LIMIT_PER_15MIN||30),standardHeaders:true,legacyHeaders:false,message:{error:'Too many authentication attempts. Please try again later.'}});
router.use(authLimiter);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const roleMap = { student:'STUDENT', admin:'ADMIN', coordinator:'COORDINATOR', teacher:'TEACHER', mentor:'MENTOR' };
const RECOVERY_TTL_MS = 10 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_COOLDOWN_MS = 30 * 1000;

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function passwordIsStrong(password) {
  const p = String(password || '');
  return p.length >= 8 && p.length <= 200;
}
function randomRecoveryCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashRecoveryCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }
function safeEqualHex(a,b) {
  try {
    const aa=Buffer.from(String(a),'hex'), bb=Buffer.from(String(b),'hex');
    return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
  } catch (_) { return false; }
}
function genericRecoveryResponse(res) {
  return res.status(200).json({ok:true,message:'If an account exists, recovery instructions have been sent.'});
}


function publicUser(u, account = null) {
  return {
    id:u.id,email:u.email,name:u.name,role:String(u.role).toLowerCase(),branch:u.branch || account?.branch || null,
    year:u.year || account?.year || '', graduationYear:u.graduationYear || null,
    photo:u.photo || account?.photo || null, mustChangePassword:!!u.mustChangePassword,
    classTeacherEmail:u.classTeacherEmail || account?.classTeacherEmail || '',
    mentorEmail:u.mentorEmail || account?.mentorEmail || '',
  };
}
async function issue(user, req, res, account=null) {
  const accessToken=signAccessToken(user), refreshToken=generateRefreshToken();
  await prisma.refreshToken.create({data:{tokenHash:hashRefreshToken(refreshToken),userId:user.id,expiresAt:refreshExpiryDate(),userAgent:req.headers['user-agent']||null,ip:req.ip}});
  res.cookie('cp_refresh', refreshToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.COOKIE_SAMESITE||'lax',path:'/api/auth',maxAge:Number(process.env.JWT_REFRESH_EXPIRES_DAYS||30)*24*60*60*1000});
  res.cookie('cp_access', accessToken, {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.COOKIE_SAMESITE||'lax',path:'/',maxAge:15*60*1000});
  res.json({accessToken,user:publicUser(user,account)});
}
async function mirrorAccount(user, extra={}) {
  const existing = await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${user.email}`}});
  const old = existing?.value && typeof existing.value === 'object' ? existing.value : {};
  const value = {...old,...extra,email:user.email,name:user.name,role:String(user.role).toLowerCase(),branch:user.branch||old.branch||'',year:user.year||old.year||'',photo:user.photo||old.photo||null,mustChangePassword:!!user.mustChangePassword};
  delete value.passwordHash; delete value.salt; delete value.legacySalt; delete value.codeHash; delete value.recoveryCode; delete value.password; delete value.newPassword;
  await prisma.portalKV.upsert({where:{scope_key_ownerId:{scope:'shared',key:`account:${user.email}`,ownerId:'PUBLIC'}},create:{scope:'shared',key:`account:${user.email}`,ownerId:'PUBLIC',value},update:{value}});
  return value;
}

router.post('/bootstrap-admin', async (req,res)=>{
  try{
    const email=String(process.env.PORTAL_ADMIN_EMAIL||'').trim().toLowerCase();
    const password=String(process.env.PORTAL_ADMIN_PASSWORD||'');
    const name=String(process.env.PORTAL_ADMIN_NAME||'Professor-In-Charge (T&P)');
    if(!email||password.length<8) return res.status(503).json({error:'PORTAL_ADMIN_EMAIL and PORTAL_ADMIN_PASSWORD must be configured on the backend.'});
    let u=await prisma.user.findUnique({where:{email}});
    if(!u){
      u=await prisma.user.create({data:{email,passwordHash:await hashPassword(password),name,role:'ADMIN'}});
      await mirrorAccount(u,{email,name,role:'admin'});
    }
    return res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not bootstrap the administrator account.'});}
});

router.post('/register', async (req,res)=>{
  try {
    const b=req.body||{}, email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    if(!EMAIL_RE.test(email)) return res.status(400).json({error:'A valid email is required.'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters.'});
    if(!b.name?.trim()) return res.status(400).json({error:'Name is required.'});
    // The recovery e-mail is captured ONCE, here, at account creation. It cannot be edited later
    // (see PATCH /me and /api/storage/kv), so reset codes always go to the address given at signup.
    const recoveryEmail=normalizeEmail(b.recoveryEmail)||email;
    if(!EMAIL_RE.test(recoveryEmail)) return res.status(400).json({error:'A valid recovery email is required.'});
    if(await prisma.user.findUnique({where:{email}})) return res.status(409).json({error:'An account with this email already exists.'});
    const coord=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:'coordinator-emails'}});
    const coordinatorEmails=Array.isArray(coord?.value)?coord.value.map(x=>String(x).toLowerCase()):[];
    const role=coordinatorEmails.includes(email)?'COORDINATOR':'STUDENT';
    const user=await prisma.user.create({data:{
      email,passwordHash:await hashPassword(password),name:String(b.name).trim(),role,
      branch:b.branch||null,year:b.year||null,photo:b.photo||null,recoveryEmail,
      mustChangePassword:!!b.mustChangePassword,faceDescriptor:b.faceDescriptor||null,fingerprintCredentialId:b.fingerprintCredentialId||null,
      classTeacherEmail:b.classTeacherEmail||null,mentorEmail:b.mentorEmail||null
    }});
    // The User row is the source of truth. A failure while mirroring the profile copy (PortalKV) must
    // never make sign-up look like it failed, so it is logged and the account is still returned.
    try { await mirrorAccount(user,{...b,recoveryEmail,passwordHash:undefined,salt:undefined}); }
    catch(mirrorErr){ console.error('[portal-auth/register] profile mirror failed:', mirrorErr && mirrorErr.message); }
    await issue(user,req,res);
  } catch(e){
    console.error('[portal-auth/register] failed:', e && (e.code||''), e && e.message);
    if(e && e.code==='P2002') return res.status(409).json({error:'An account with this email already exists.'});
    if(e && (e.code==='P2021'||e.code==='P2022')) return res.status(500).json({error:'The database is missing tables/columns. Run: cd backend && npx prisma migrate deploy'});
    if(e && (e.code==='P1001'||e.code==='P1002'||e.code==='P1000'||/Can't reach database|DATABASE_URL/i.test(String(e.message||'')))) return res.status(503).json({error:'The portal cannot reach its database. Check DATABASE_URL in backend/.env and that PostgreSQL is running.'});
    res.status(500).json({error:'Could not create account: '+String((e&&e.message)||'unknown error').split('\n').filter(Boolean).pop().slice(0,200)});
  }
});

router.post('/login', async (req,res)=>{
  try {
    const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
    const user=await prisma.user.findUnique({where:{email}});
    if(!user) return res.status(401).json({error:'Invalid email or password.'});
    let ok=false;
    try { ok=await verifyPassword(password,user.passwordHash); } catch(_){}
    // Backward-compatible verifier for imported legacy SHA-256+salt records.
    if(!ok){
      const acc=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${email}`}});
      const a=acc?.value;
      if(a?.salt && a?.passwordHash){
        const legacy=crypto.createHash('sha256').update(`${a.salt}::${password}`).digest('hex');
        ok=legacy===a.passwordHash;
        if(ok) await prisma.user.update({where:{id:user.id},data:{passwordHash:await hashPassword(password)}});
      }
    }
    if(!ok) return res.status(401).json({error:'Invalid email or password.'});
    await prisma.user.update({where:{id:user.id},data:{lastLoginAt:new Date()}});
    await issue({...user,lastLoginAt:new Date()},req,res);
  } catch(e){res.status(500).json({error:'Login failed.'});}
});

router.get('/lookup', async (req,res)=>{
  try{
    const email=String(req.query.email||'').trim().toLowerCase();
    const u=await prisma.user.findUnique({where:{email}});
    const acc=await prisma.portalKV.findFirst({where:{scope:'shared',ownerId:'PUBLIC',key:`account:${email}`}});
    const a=acc?.value && typeof acc.value==='object'?acc.value:{};
    if(!u && !acc) return res.status(404).json({error:'Account not found.'});
    res.json({user:u?publicUser(u,a):{email,name:a.name||'',role:a.role||'student',branch:a.branch||'',year:a.year||'',photo:a.photo||null}});
  }catch(_){res.status(500).json({error:'Lookup failed.'});}
});

router.post('/face-login', async (req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase(), descriptor=Array.isArray(req.body?.descriptor)?req.body.descriptor:null;
    const u=await prisma.user.findUnique({where:{email}});
    if(!u || !Array.isArray(u.faceDescriptor) || !descriptor) return res.status(401).json({error:'Face ID is not configured for this account.'});
    const stored=u.faceDescriptor.map(Number), live=descriptor.map(Number);
    if(stored.length!==live.length || !stored.length) return res.status(401).json({error:'Face ID did not match.'});
    let sum=0; for(let i=0;i<stored.length;i++){const d=stored[i]-live[i];sum+=d*d;}
    const distance=Math.sqrt(sum);
    const threshold=Number(process.env.FACE_MATCH_THRESHOLD||0.48);
    if(distance>=threshold) return res.status(401).json({error:'Face ID did not match.'});
    await issue(u,req,res);
  }catch(_){res.status(500).json({error:'Face login failed.'});}
});

router.post('/fingerprint-login', async (req,res)=>{
  try{
    const email=String(req.body?.email||'').trim().toLowerCase();
    const credentialId=String(req.body?.credentialId||'');
    const u=await prisma.user.findUnique({where:{email}});
    if(!u || !credentialId || u.fingerprintCredentialId!==credentialId) return res.status(401).json({error:'Fingerprint is not registered for this account.'});
    await issue(u,req,res);
  }catch(_){res.status(500).json({error:'Fingerprint login failed.'});}
});

router.patch('/me',requireAuth,async(req,res)=>{
  try{
    const patch=req.body||{};
    const u=await prisma.user.update({where:{id:req.user.sub},data:{
      ...(patch.name!==undefined?{name:String(patch.name).trim()}:{}),
      ...(patch.branch!==undefined?{branch:patch.branch||null}:{}),
      ...(patch.year!==undefined?{year:patch.year||null}:{}),
      ...(patch.photo!==undefined?{photo:patch.photo||null}:{}),
      ...(patch.faceDescriptor!==undefined?{faceDescriptor:patch.faceDescriptor||null}:{}),
      ...(patch.fingerprintCredentialId!==undefined?{fingerprintCredentialId:patch.fingerprintCredentialId||null}:{}),
      ...(patch.classTeacherEmail!==undefined?{classTeacherEmail:patch.classTeacherEmail||null}:{}),
      ...(patch.mentorEmail!==undefined?{mentorEmail:patch.mentorEmail||null}:{}),
    }});
    const safePatch={...patch}; delete safePatch.recoveryEmail; // locked at account creation
    await mirrorAccount(u,{...safePatch,recoveryEmail:u.recoveryEmail||u.email});
    res.json({user:publicUser(u)});
  }catch(_){res.status(500).json({error:'Could not update account.'});}
});

router.get('/recovery/status',async(_req,res)=>{
  try{
    const cfg=await mailer.resolveConfig();
    res.json({configured:cfg.configured,privateKeySet:!!cfg.privateKey,missing:cfg.missing});
  }catch(_){res.status(500).json({error:'Could not read recovery configuration.'});}
});

router.post('/recovery/start',rateLimit({windowMs:15*60*1000,max:8,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email);
    if(!EMAIL_RE.test(email)) return genericRecoveryResponse(res);
    // Configuration problems are system-wide (not account specific), so they can be reported
    // honestly without revealing whether an account exists.
    const cfg=await mailer.resolveConfig();
    if(!cfg.configured){
      console.error('[recovery] E-mail delivery is not configured. Missing:',cfg.missing.join(', '));
      return res.status(503).json({ok:false,error:'Password recovery e-mail is not set up yet. Please ask the T&P admin to configure it (Settings -> Email delivery).'});
    }
    const now=new Date();
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return genericRecoveryResponse(res);
    const recent=await prisma.passwordRecovery.findFirst({where:{userId:u.id,createdAt:{gt:new Date(Date.now()-RECOVERY_COOLDOWN_MS)},usedAt:null},orderBy:{createdAt:'desc'}});
    if(recent) return genericRecoveryResponse(res);
    await prisma.passwordRecovery.updateMany({where:{userId:u.id,usedAt:null},data:{usedAt:now}});
    const code=randomRecoveryCode();
    const record=await prisma.passwordRecovery.create({data:{userId:u.id,tokenHash:hashRecoveryCode(code),expiresAt:new Date(Date.now()+RECOVERY_TTL_MS)}});
    // The code goes ONLY to the address the user gave when the account was created.
    const deliveryEmail=normalizeEmail(u.recoveryEmail)||u.email;
    try { await mailer.sendRecoveryCode(deliveryEmail,code,{name:u.name}); }
    catch (deliveryError) {
      await prisma.passwordRecovery.update({where:{id:record.id},data:{usedAt:new Date()}}).catch(()=>{});
      console.error('[recovery] Delivery failed:',deliveryError.code||'',deliveryError.status||'',deliveryError.detail||deliveryError.message,'|',deliveryError.hint||'');
      const showDetail=!config.isProduction||process.env.RECOVERY_EXPOSE_DELIVERY_DETAIL==='true';
      return res.status(502).json({ok:false,error:'We could not send the recovery e-mail right now. Please try again in a minute or contact the T&P admin.',...(showDetail?{detail:deliveryError.hint||deliveryError.message}:{})});
    }
    return genericRecoveryResponse(res);
  }catch(e){ console.error('[recovery] start failed:',e&&e.message); return res.status(500).json({ok:false,error:'Could not start password recovery. Please try again.'}); }
});

router.post('/recovery/verify',rateLimit({windowMs:15*60*1000,max:10,standardHeaders:true,legacyHeaders:false}),async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email), code=String(req.body?.code||'').trim();
    if(!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({error:'Invalid recovery code.'});
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return res.status(400).json({error:'Invalid or expired recovery code.'});
    const row=await prisma.passwordRecovery.findFirst({where:{userId:u.id,usedAt:null},orderBy:{createdAt:'desc'}});
    if(!row || row.expiresAt<=new Date()) return res.status(400).json({error:'This code has expired. Please request a new one.'});
    if(row.attempts>=RECOVERY_MAX_ATTEMPTS) return res.status(429).json({error:'Too many incorrect attempts. Please request a new code.'});
    const actual=hashRecoveryCode(code);
    if(!safeEqualHex(actual,row.tokenHash)) {
      const attempts=row.attempts+1;
      await prisma.passwordRecovery.update({where:{id:row.id},data:{attempts,usedAt:attempts>=RECOVERY_MAX_ATTEMPTS?new Date():null}});
      return res.status(400).json({error:'Invalid or expired recovery code.'});
    }
    await prisma.passwordRecovery.update({where:{id:row.id},data:{verifiedAt:new Date()}});
    return res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not verify recovery code.'});}
});

router.post('/recovery/reset',async(req,res)=>{
  try{
    const email=normalizeEmail(req.body?.email), next=String(req.body?.newPassword||'');
    if(!EMAIL_RE.test(email) || !passwordIsStrong(next)) return res.status(400).json({error:'A valid email and password of at least 8 characters are required.'});
    const u=await prisma.user.findUnique({where:{email}});
    if(!u) return res.status(400).json({error:'Your verification has expired. Please start over.'});
    const row=await prisma.passwordRecovery.findFirst({where:{userId:u.id,usedAt:null},orderBy:{createdAt:'desc'}});
    if(!row?.verifiedAt || row.expiresAt<=new Date()) return res.status(400).json({error:'Your verification has expired. Please start over.'});
    await prisma.$transaction(async tx=>{
      await tx.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(next),mustChangePassword:false}});
      await tx.refreshToken.updateMany({where:{userId:u.id,revokedAt:null},data:{revokedAt:new Date()}});
      await tx.passwordRecovery.update({where:{id:row.id},data:{usedAt:new Date()}});
    });
    res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not reset password.'});}
});

router.post('/change-password',requireAuth,async(req,res)=>{
  try{
    const current=String(req.body?.currentPassword||''), next=String(req.body?.newPassword||'');
    if(!passwordIsStrong(next)) return res.status(400).json({error:'New password must be at least 8 characters.'});
    const u=await prisma.user.findUnique({where:{id:req.user.sub}});
    if(!u || !(await verifyPassword(current,u.passwordHash))) return res.status(401).json({error:'Current password is incorrect.'});
    const updated=await prisma.user.update({where:{id:u.id},data:{passwordHash:await hashPassword(next),mustChangePassword:false}});
    await mirrorAccount(updated,{mustChangePassword:false});
    res.json({ok:true});
  }catch(_){res.status(500).json({error:'Could not change password.'});}
});

router.post('/admin/create',requireAuth,async(req,res)=>{
  try{
    if(String(req.user.role).toUpperCase()!=='ADMIN') return res.status(403).json({error:'Admin access required.'});
    const b=req.body||{}, email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    if(!EMAIL_RE.test(email)||password.length<8||!b.name) return res.status(400).json({error:'Valid email, name and password are required.'});
    if(await prisma.user.findUnique({where:{email}})) return res.status(409).json({error:'An account with this email already exists.'});
    const role=roleMap[String(b.role||'student').toLowerCase()]||'STUDENT';
    const user=await prisma.user.create({data:{email,passwordHash:await hashPassword(password),name:String(b.name).trim(),role,branch:b.branch||null,year:b.year||null,mustChangePassword:!!b.mustChangePassword,recoveryEmail:normalizeEmail(b.recoveryEmail)||email}});
    await mirrorAccount(user,b);
    res.json({user:publicUser(user)});
  }catch(_){res.status(500).json({error:'Could not create account.'});}
});

function requireAdminRole(req,res){
  if(String(req.user?.role||'').toUpperCase()!=='ADMIN'){res.status(403).json({error:'Admin access required.'});return false;}
  return true;
}
const maskKey=(v)=>v?`${String(v).slice(0,3)}••••${String(v).slice(-2)}`:'';

router.get('/admin/email-config',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    const cfg=await mailer.resolveConfig();
    res.json({serviceId:cfg.serviceId,templateId:cfg.templateId,publicKey:cfg.publicKey,privateKeyMasked:maskKey(cfg.privateKey),privateKeySet:!!cfg.privateKey,configured:cfg.configured,missing:cfg.missing});
  }catch(_){res.status(500).json({error:'Could not read e-mail configuration.'});}
});

router.put('/admin/email-config',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    const b=req.body||{};
    await mailer.saveStoredConfig({serviceId:b.serviceId,templateId:b.templateId,publicKey:b.publicKey,privateKey:b.privateKey});
    const cfg=await mailer.resolveConfig();
    res.json({ok:true,configured:cfg.configured,privateKeySet:!!cfg.privateKey,missing:cfg.missing});
  }catch(_){res.status(500).json({error:'Could not save e-mail configuration.'});}
});

// Admin-only: sends a real test mail and returns EmailJS's exact answer so problems are visible.
router.post('/admin/email-test',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    const to=normalizeEmail(req.body?.to);
    if(!EMAIL_RE.test(to)) return res.status(400).json({error:'Enter a valid e-mail address to send the test to.'});
    try{
      await mailer.sendRecoveryCode(to,'123456',{purpose:'test e-mail',message:'This is a test e-mail from the Campus Portal. Code 123456 is a sample.'});
      res.json({ok:true,message:`Test e-mail sent to ${to}. Check the inbox (and spam).`});
    }catch(err){
      res.status(200).json({ok:false,error:err.message,status:err.status||null,detail:err.detail||'',hint:err.hint||''});
    }
  }catch(_){res.status(500).json({error:'Could not send the test e-mail.'});}
});

// ---- Admin: AI keys + AI/ML service link ----------------------------------------------------------
// The Admin pastes Groq / Gemini keys and (optionally) the AI/ML service link. They are stored in the database,
// applied live, and forwarded to the AI/ML service on every call - no .env edit and no restart needed.
router.get('/admin/ai-config',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    await aiRuntime.ensureFresh(0);
    res.json({...aiRuntime.publicView(),service:await mlLauncher.status()});
  }catch(_){res.status(500).json({error:'Could not read the AI configuration.'});}
});

router.put('/admin/ai-config',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    const b=req.body||{};
    const input={};
    for(const f of ['groqKey','geminiKey','groqModel','geminiModel','aiMlUrl','aiMlToken','providerOrder','aiMlAutostart','clear']) if(b[f]!==undefined) input[f]=b[f];
    let result;
    try{ result=await aiRuntime.save(input); }
    catch(e){
      if(e&&e.code&&String(e.code).startsWith('P')) return res.status(500).json({error:'The database rejected the save. Check DATABASE_URL and run the migrations.'});
      return res.status(400).json({error:String(e&&e.message||'Invalid AI configuration.')});
    }
    // A changed link/token restarts (or re-attaches to) the AI/ML service; changed keys need no restart.
    let service; try{ service=await mlLauncher.status(); }catch(_){ service={state:'unknown'}; }
    res.json({ok:true,changed:result.changed,...result.view,service});
  }catch(_){res.status(500).json({error:'Could not save the AI configuration.'});}
});

async function timedFetch(url,opts={},ms=15000){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),ms);
  try{ return await fetch(url,{...opts,signal:ctrl.signal}); } finally{ clearTimeout(t); }
}
const short=(t)=>String(t||'').replace(/\s+/g,' ').slice(0,220);

// Admin-only: really calls Groq, Gemini and the AI/ML service and reports what each one answered.
router.post('/admin/ai-test',requireAuth,async(req,res)=>{
  try{
    if(!requireAdminRole(req,res)) return;
    await aiRuntime.ensureFresh(0);
    const view=aiRuntime.publicView(); const out={};
    // The live key values are read through the same object server.js uses (never sent back to the browser).
    const ml=aiRuntime.getMl();
    const live={groq:ml.headers['x-groq-key']||'',gemini:ml.headers['x-gemini-key']||''};
    const models={groq:ml.headers['x-groq-model']||view.groq.model,gemini:ml.headers['x-gemini-model']||view.gemini.model};

    if(!live.groq) out.groq={ok:false,message:'No Groq key saved yet.'};
    else try{
      const r=await timedFetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${live.groq}`},body:JSON.stringify({model:models.groq,messages:[{role:'user',content:'Reply with the single word: ok'}],max_tokens:16})});
      const t=await r.text();
      out.groq=r.ok?{ok:true,message:`Groq answered (model ${models.groq}).`}:{ok:false,status:r.status,message:r.status===401?'Groq rejected the key (401). Re-copy it from console.groq.com/keys.':r.status===404||r.status===400?`Groq rejected the model "${models.groq}". ${short(t)}`:`Groq error ${r.status}. ${short(t)}`};
    }catch(e){out.groq={ok:false,message:`Could not reach Groq: ${short(e.message)}`};}

    if(!live.gemini) out.gemini={ok:false,message:'No Gemini key saved yet.'};
    else try{
      const r=await timedFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(models.gemini)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':live.gemini},body:JSON.stringify({contents:[{role:'user',parts:[{text:'Reply with the single word: ok'}]}],generationConfig:{maxOutputTokens:16}})});
      const t=await r.text();
      out.gemini=r.ok?{ok:true,message:`Gemini answered (model ${models.gemini}).`}:{ok:false,status:r.status,message:r.status===400&&/API key/i.test(t)?'Gemini rejected the key. Re-copy it from aistudio.google.com/apikey.':r.status===403?'Gemini refused the key (403). Enable the Generative Language API for it.':`Gemini error ${r.status}. ${short(t)}`};
    }catch(e){out.gemini={ok:false,message:`Could not reach Gemini: ${short(e.message)}`};}

    // AI/ML service: liveness, then an authenticated call (proves the token matches).
    try{
      const s=await mlLauncher.status();
      if(!s.healthy) out.aiMl={ok:false,state:s.state,message:s.lastError||`The AI/ML service at ${ml.url} is not reachable (state: ${s.state}).`};
      else{
        const r=await timedFetch(`${ml.url}/adaptive/topics`,{headers:{'x-service-token':ml.token,...ml.headers}},10000);
        out.aiMl=r.ok?{ok:true,state:s.state,message:`AI/ML service is running at ${ml.url}.`}:{ok:false,state:s.state,status:r.status,message:r.status===401?'The AI/ML service is running but rejected the service token. Paste the same token that service uses (AI_ML_SERVICE_TOKEN) in the token box.':`AI/ML service answered ${r.status}.`};
      }
    }catch(e){out.aiMl={ok:false,message:`Could not reach the AI/ML service: ${short(e.message)}`};}
    res.json({ok:!!(out.aiMl&&out.aiMl.ok)&&!!((out.groq&&out.groq.ok)||(out.gemini&&out.gemini.ok)),results:out});
  }catch(_){res.status(500).json({error:'The AI test could not be completed.'});}
});

module.exports=router;
