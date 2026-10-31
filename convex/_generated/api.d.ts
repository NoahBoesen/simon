/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as attendees from "../attendees.js";
import type * as auth from "../auth.js";
import type * as dev from "../dev.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as importGuests from "../importGuests.js";
import type * as lib_llm from "../lib/llm.js";
import type * as matches from "../matches.js";
import type * as matching from "../matching.js";
import type * as messages from "../messages.js";
import type * as photon from "../photon.js";
import type * as pings from "../pings.js";
import type * as research from "../research.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  attendees: typeof attendees;
  auth: typeof auth;
  dev: typeof dev;
  events: typeof events;
  http: typeof http;
  importGuests: typeof importGuests;
  "lib/llm": typeof lib_llm;
  matches: typeof matches;
  matching: typeof matching;
  messages: typeof messages;
  photon: typeof photon;
  pings: typeof pings;
  research: typeof research;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
