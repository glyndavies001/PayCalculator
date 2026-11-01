// @ts-nocheck
// Supabase Edge Function entry point. The logic lives in handler.ts.
import { handler } from "./handler.ts";

Deno.serve(handler);
