import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { app } from "./server.js";

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`listening on http://localhost:${info.port}`);
});
