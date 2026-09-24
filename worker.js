const ALLOWED_ORIGINS = [
  "https://negoaja.pages.dev",
  "http://localhost:8788",
  "http://localhost:5173"
];

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {"Content-Type":"application/json; charset=utf-8", ...corsHeaders(request)}
  });
}

function sbHeaders(env, token, admin=false) {
  const key = admin ? env.SUPABASE_SERVICE_ROLE_KEY : env.SUPABASE_PUBLISHABLE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${token || key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation"
  };
}

async function sb(env, path, options={}) {
  return fetch(`${env.SUPABASE_URL}${path}`, options);
}

async function adminInsertAdaptive(env, table, row) {
  const work = {...row};
  for (let i=0;i<8;i++) {
    const r = await sb(env, `/rest/v1/${table}`, {
      method:"POST",
      headers:sbHeaders(env,null,true),
      body:JSON.stringify(work)
    });
    const text = await r.text();
    if (r.ok) {
      try { return JSON.parse(text || "null"); } catch { return null; }
    }
    let missing = null;
    try {
      const j=JSON.parse(text);
      const msg=String(j.message||j.hint||j.details||"");
      const m=msg.match(/column [^\s.]+\.([a-zA-Z0-9_]+) does not exist/i)
        || msg.match(/Could not find the '([a-zA-Z0-9_]+)' column/i);
      missing=m?.[1]||null;
    } catch {}
    if (!missing || !(missing in work)) throw new Error(`${table}: ${text}`);
    delete work[missing];
  }
  throw new Error(`${table}: terlalu banyak percobaan adaptasi schema.`);
}

async function authUser(env, request) {
  const auth=request.headers.get("Authorization")||"";
  if(!auth.startsWith("Bearer ")) return null;
  const token=auth.slice(7);
  const r=await sb(env,"/auth/v1/user",{
    headers:{
      apikey:env.SUPABASE_PUBLISHABLE_KEY,
      Authorization:`Bearer ${token}`
    }
  });
  if(!r.ok) return null;
  return await r.json();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null,{status:204,headers:corsHeaders(request)});
    }

    const url=new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok:true,
        service:"NegoAja Server",
        version:"2.0.0",
        status:"online",
        supabase_configured:Boolean(
          env.SUPABASE_URL &&
          env.SUPABASE_PUBLISHABLE_KEY &&
          env.SUPABASE_SERVICE_ROLE_KEY
        ),
        timestamp:new Date().toISOString()
      },200,request);
    }

    if (url.pathname === "/api/server/check") {
      return json({
        ok:Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY),
        service:"NegoAja Server",
        database:"configured"
      },200,request);
    }

    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
      return json({ok:false,error:"Supabase server configuration incomplete"},500,request);
    }

    if (url.pathname === "/api/auth/me") {
      const u=await authUser(env,request);
      if(!u) return json({ok:false,error:"Invalid authentication"},401,request);
      return json({ok:true,user:u},200,request);
    }

    let body={};
    if (request.method !== "GET") {
      try { body=await request.json(); }
      catch { return json({ok:false,error:"JSON tidak valid."},400,request); }
    }

    if (url.pathname === "/api/merchant/register") {
      if(!env.SUPABASE_SERVICE_ROLE_KEY) return json({error:"SUPABASE_SERVICE_ROLE_KEY belum dipasang di Worker."},500,request);
      const {email,password,name,phone,shopName,shopDescription,businessType,productName,productDescription,price,stock}=body;
      if(!email||!password||!name||!shopName||!businessType||!productName||Number(price)<=0)
        return json({error:"Data akun, toko, jenis usaha, dan produk pertama wajib lengkap."},400,request);

      let userId=null;
      try {
        const existing=await sb(env,"/auth/v1/admin/users",{
          method:"POST",headers:sbHeaders(env,null,true),
          body:JSON.stringify({
            email,password,email_confirm:true,
            user_metadata:{full_name:name,business_type:businessType}
          })
        });
        const et=await existing.text();
        if(!existing.ok) {
          let msg=et; try{const j=JSON.parse(et);msg=j.msg||j.message||msg;}catch{}
          throw new Error(msg);
        }
        const u=JSON.parse(et); userId=u.user?.id||u.id;
        if(!userId) throw new Error("User merchant tidak mendapatkan ID.");

        await adminInsertAdaptive(env,"profiles",{
          id:userId,full_name:name,phone:phone||null,role:"merchant",business_type:businessType
        });
        const shop=await adminInsertAdaptive(env,"shops",{
          owner_id:userId,name:shopName,description:shopDescription||null,business_type:businessType
        });
        const shopId=shop?.[0]?.id||shop?.id;
        if(!shopId) throw new Error("Toko berhasil dibuat tetapi ID toko tidak terbaca.");

        await adminInsertAdaptive(env,"products",{
          shop_id:shopId,name:productName,description:productDescription||null,
          price:Number(price),stock:Number(stock||0),image_url:null
        });
        return json({ok:true,user_id:userId,shop_id:shopId},200,request);
      } catch(e) {
        if(userId && env.SUPABASE_SERVICE_ROLE_KEY) {
          try { await sb(env,`/auth/v1/admin/users/${userId}`,{
            method:"DELETE",headers:sbHeaders(env,null,true)
          }); } catch {}
        }
        return json({error:String(e.message||e)},400,request);
      }
    }

    if (url.pathname === "/api/profile") {
      const u=await authUser(env,request);
      if(!u) return json({error:"Sesi pengguna diperlukan."},401,request);
      if(!env.SUPABASE_SERVICE_ROLE_KEY) return json({error:"Worker belum memiliki service role."},500,request);
      const p={
        id:u.id,
        full_name:body.full_name,
        phone:body.phone||null,
        address:body.address||null,
        latitude:body.latitude??null,
        longitude:body.longitude??null,
        role:"buyer"
      };
      try {
        const data=await adminInsertAdaptive(env,"profiles",p);
        return json({ok:true,profile:data},200,request);
      } catch(e) {
        return json({error:String(e.message||e)},400,request);
      }
    }

    if (url.pathname.startsWith("/rpc/")) {
      const fn=url.pathname.slice(5);
      if(!/^[a-z_][a-z0-9_]*$/.test(fn)) return json({error:"RPC tidak valid."},400,request);
      const auth=request.headers.get("Authorization")||"";
      const token=auth.replace(/^Bearer\s+/i,"");
      const r=await sb(env,`/rest/v1/rpc/${fn}`,{
        method:"POST",
        headers:sbHeaders(env,token),
        body:JSON.stringify(body)
      });
      return new Response(await r.text(),{
        status:r.status,
        headers:{"Content-Type":r.headers.get("content-type")||"application/json",...corsHeaders(request)}
      });
    }

    return json({ok:false,error:"Endpoint not found",path:url.pathname},404,request);
  },

  async scheduled(event,env) {
    if(!env.SUPABASE_SERVICE_ROLE_KEY) return;
    try {
      await sb(env,"/rest/v1/rpc/process_cod_reminders",{
        method:"POST",headers:sbHeaders(env,null,true),body:"{}"
      });
    } catch(e) {
      console.log(String(e));
    }
  }
};
