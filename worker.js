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
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request)
    }
  });
}

function supabaseHeaders(env, token) {
  return {
    "apikey": env.SUPABASE_PUBLISHABLE_KEY,
    "Authorization": `Bearer ${token || env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}

async function supabaseRequest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      ...supabaseHeaders(env, options.token),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        return json(
          {
            ok: true,
            service: "NegoAja Server",
            version: "2.0.0",
            status: "online",
            supabase_configured: Boolean(
              env.SUPABASE_URL &&
              env.SUPABASE_PUBLISHABLE_KEY &&
              env.SUPABASE_SERVICE_ROLE_KEY
            ),
            timestamp: new Date().toISOString()
          },
          200,
          request
        );
      }

      if (url.pathname === "/api/server/check") {
        if (
          !env.SUPABASE_URL ||
          !env.SUPABASE_PUBLISHABLE_KEY ||
          !env.SUPABASE_SERVICE_ROLE_KEY
        ) {
          return json(
            {
              ok: false,
              error: "Supabase server configuration incomplete"
            },
            500,
            request
          );
        }

        return json(
          {
            ok: true,
            service: "NegoAja Server",
            database: "configured",
            message: "Cloudflare Worker siap terhubung ke Supabase"
          },
          200,
          request
        );
      }

      if (url.pathname === "/api/auth/me") {
        const auth = request.headers.get("Authorization");

        if (!auth || !auth.startsWith("Bearer ")) {
          return json(
            {
              ok: false,
              error: "Authorization required"
            },
            401,
            request
          );
        }

        const token = auth.substring(7);

        const result = await supabaseRequest(
          env,
          "/auth/v1/user",
          {
            token,
            headers: {
              "apikey": env.SUPABASE_PUBLISHABLE_KEY,
              "Authorization": `Bearer ${token}`
            }
          }
        );

        if (!result.ok) {
          return json(
            {
              ok: false,
              error: "Invalid authentication"
            },
            401,
            request
          );
        }

        return json(
          {
            ok: true,
            user: result.data
          },
          200,
          request
        );
      }

      return json(
        {
          ok: false,
          error: "Endpoint not found",
          path: url.pathname
        },
        404,
        request
      );
    } catch (error) {
      console.error("NegoAja Server Error:", error);

      return json(
        {
          ok: false,
          error: "Internal server error"
        },
        500,
        request
      );
    }
  },

  async scheduled(event, env, ctx) {
    console.log(
      JSON.stringify({
        event: "scheduled",
        timestamp: new Date().toISOString()
      })
    );
  }
};
