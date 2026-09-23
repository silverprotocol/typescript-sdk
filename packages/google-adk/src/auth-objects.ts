/**
 * ADK auth objects inside anything the facet carries: the flat AgAuthConfig
 * view, the member allowlists, the shared-state credential omission and the
 * node-data reduction. Internal to @silverprotocol/google-adk (not part of its
 * package exports); index.ts is the only importer, and the tests call these
 * helpers directly.
 */
import { JsonValue, type AgAuthConfig } from "@silverprotocol/core";
import { isJsonObject, stringMember } from "./json-guards.js";

// ─── ADK AuthConfig → flat AgAuthConfig view (SPEC §8.0 item 12) ─────────────
// ADK's AuthConfig (@google/adk 2.1.0 dist/types/auth/auth_tool.d.ts:12-42) is
// `{ authScheme, rawAuthCredential?, exchangedAuthCredential?, credentialKey }`,
// with authScheme an OpenAPI v3 SecuritySchemeObject or OIDC-with-config
// (auth_schemes.d.ts:12, :25). The view maps ONLY what has a native value:
// - scheme ← authScheme.type, verbatim; no string type → no view at all (the
//   field is required and never invented);
// - authorizationUrl / tokenUrl / scopes follow ADK's own derivation
//   (dist/esm/auth/auth_handler.js:112-128): OIDC-with-config's
//   authorizationEndpoint / tokenEndpoint / scopes; for oauth2, the first
//   present flow of implicit > authorizationCode > clientCredentials >
//   password, with scopes = the keys of its OpenAPI scopes map;
// - clientId / audience ← rawAuthCredential.oauth2 (auth_credential.d.ts:35-62).
// credentialKey, secrets and exchange state never enter the view.
// ─── ADK auth objects: carry only members known to be non-secret ─────────────
// An ADK AuthConfig, and the credential objects inside it, can hold credential
// material. Anything the facet forwards is persisted by hosts (hitl.ask →
// turn.done paused asks[]; tool-call blocks). So every carrier of an ADK auth
// object is an ALLOWLIST: a member is forwarded only when it is known to be
// non-secret, and every other member, at any depth, is omitted. The list is
// checked against @google/adk 2.1.0 dist/types/auth/auth_tool.d.ts and
// auth_credential.d.ts. Keys match in camelCase or snake_case (the reserved
// call's args arrive snake_case at the top level); a kept key keeps its wire
// spelling.
//
// Resume safety (ADK 2.1.0, a tool's credential request inside an LlmAgent):
// the credential resume rebuilds the request
// server-side from the session's own reserved call (auth_preprocessor.js
// requestedAuthConfigs) and takes only the auth code / response URI from the
// client's answer (credential_response_binding.js bindCredential; the raw
// credential is restored from the request). An oauth2/OIDC request always
// carries a generated authUri (auth_handler.js generateAuthRequest). So what
// the allowlist omits is never needed to answer the ask.
export const ADK_REQUEST_CREDENTIAL = "adk_request_credential";

type AllowSpec = { [key: string]: true | ((v: JsonValue) => JsonValue | undefined) };

export function snakeKey(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Copy only the allowlisted members of `v` (camel or snake spelling), each
 *  either verbatim (`true`) or through its nested allowlist. */
export function pickAllowed(v: JsonValue | undefined, spec: AllowSpec): JsonValue | undefined {
  if (!isJsonObject(v)) return undefined;
  const out: { [k: string]: JsonValue } = {};
  for (const [name, rule] of Object.entries(spec)) {
    for (const key of name === snakeKey(name) ? [name] : [name, snakeKey(name)]) {
      if (!Object.hasOwn(v, key)) continue;
      const member = v[key];
      if (member === undefined) continue;
      const kept = rule === true ? member : rule(member);
      if (kept !== undefined) out[key] = kept;
    }
  }
  return out;
}

const OAUTH2_ALLOW: AllowSpec = {
  clientId: true,
  authUri: true,
  redirectUri: true,
  scopes: true,
  codeChallengeMethod: true,
  tokenEndpointAuthMethod: true,
  expiresAt: true,
  expiresIn: true,
  audience: true,
};
const SERVICE_ACCOUNT_ALLOW: AllowSpec = {
  scopes: true,
  useDefaultCredential: true,
  useIdToken: true,
  audience: true,
  serviceAccountCredential: (v) =>
    pickAllowed(v, { projectId: true, clientEmail: true, tokenUri: true, universeDomain: true }),
};
const AUTH_CREDENTIAL_ALLOW: AllowSpec = {
  authType: true,
  resourceRef: true,
  oauth2: (v) => pickAllowed(v, OAUTH2_ALLOW),
  serviceAccount: (v) => pickAllowed(v, SERVICE_ACCOUNT_ALLOW),
};
// The security scheme, member by member: an OpenAPI 3.0 SecuritySchemeObject
// (openapi-types 12.1.3 OpenAPIV3: http, apiKey, oauth2 and openIdConnect,
// the type @google/adk 2.1.0's auth_schemes.d.ts names) or ADK's
// OpenIdConnectWithConfig. Every leaf is a string, a string list or a map of
// strings, and only those survive. A scheme member no type declares (a vendor
// extension, a stray field) never rides.
const schemeString = (v: JsonValue): JsonValue | undefined => (typeof v === "string" ? v : undefined);
const schemeStringList = (v: JsonValue): JsonValue | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined;
/** A map this facet rebuilds from native entries never carries an own
 *  `__proto__` key (SPEC §13.7): JsonValue.parse drops one, and
 *  Object.fromEntries would re-create it as an own property. */
function isReservedMapKey(k: string): boolean {
  return k === "__proto__";
}
/** OAuth2 flow scopes are a map of scope name -> description; OIDC config
 *  scopes are a list. Either keeps only its string entries. */
const schemeScopes = (v: JsonValue): JsonValue | undefined =>
  Array.isArray(v)
    ? schemeStringList(v)
    : isJsonObject(v)
      ? Object.fromEntries(
          Object.entries(v).filter((e): e is [string, string] => !isReservedMapKey(e[0]) && typeof e[1] === "string"),
        )
      : undefined;
const OAUTH2_FLOW_ALLOW: AllowSpec = {
  authorizationUrl: schemeString,
  tokenUrl: schemeString,
  refreshUrl: schemeString,
  scopes: schemeScopes,
};
const AUTH_SCHEME_ALLOW: AllowSpec = {
  type: schemeString,
  description: schemeString,
  // http
  scheme: schemeString,
  bearerFormat: schemeString,
  // apiKey (the header/query parameter's name and location, never its value)
  name: schemeString,
  in: schemeString,
  // oauth2 (flows.password is the password-GRANT flow: a tokenUrl and scopes)
  flows: (v) =>
    pickAllowed(v, {
      implicit: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      password: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      clientCredentials: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
      authorizationCode: (f) => pickAllowed(f, OAUTH2_FLOW_ALLOW),
    }),
  // openIdConnect
  openIdConnectUrl: schemeString,
  // OpenIdConnectWithConfig
  authorizationEndpoint: schemeString,
  tokenEndpoint: schemeString,
  userinfoEndpoint: schemeString,
  revocationEndpoint: schemeString,
  tokenEndpointAuthMethodsSupported: schemeStringList,
  grantTypesSupported: schemeStringList,
  scopes: schemeScopes,
};
const AUTH_CONFIG_ALLOW: AllowSpec = {
  authScheme: (v) => pickAllowed(v, AUTH_SCHEME_ALLOW),
  credentialKey: true,
  rawAuthCredential: (v) => pickAllowed(v, AUTH_CREDENTIAL_ALLOW),
  exchangedAuthCredential: (v) => pickAllowed(v, AUTH_CREDENTIAL_ALLOW),
};

// ─── shared state (state.delta) ──────────────────────────────────────────────
// ADK itself writes an exchanged AuthCredential into the event's
// actions.stateDelta on two paths (@google/adk 2.1.0):
// - a Runner configured with SessionStateCredentialService saves it under the
//   bare credentialKey (session_state_credential_service.js; ToolContext's
//   State writes value AND delta, agents/context.js:37-39, sessions/state.js:97-102);
// - a Workflow FunctionNode whose auth step runs again on resume stores it
//   under "temp:" + credentialKey (auth_handler.js:35-38, :47), and function_node.js
//   copies every new delta entry into the event it yields (:93-127). A Runner
//   removes "temp:" entries from a non-partial event as it appends it to the
//   session, before yielding it; a partial event, or an event read before
//   that append, still carries them.
// ADK treats any value under the key as a stored credential
// (hitl_utils.js:131-133), so the entry is omitted whole: a redacted value left
// behind would read as a credential. Every "temp:" entry is omitted too
// (invocation-scoped by ADK's contract). Every other entry rides unchanged.
const ADK_TEMP_STATE_PREFIX = "temp:";
const AUTH_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(["apiKey", "http", "oauth2", "openIdConnect", "serviceAccount"]);
// resourceRef (auth_credential.d.ts:244) names a stored credential: ADK's
// presence readers treat an object holding it as a held credential.
const AUTH_CREDENTIAL_MEMBERS = [
  "apiKey",
  "api_key",
  "http",
  "oauth2",
  "serviceAccount",
  "service_account",
  "resourceRef",
  "resource_ref",
] as const;

function isObjectRecord(v: unknown): v is { readonly [k: string]: unknown } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** An ADK AuthCredential: `authType` (either spelling) is one of ADK's
 *  credential types (auth_credential.d.ts) and a credential member is present
 *  and non-null. */
function isAuthCredentialObject(v: { readonly [k: string]: unknown }): boolean {
  const typed = ["authType", "auth_type"].some((k) => {
    const t = Object.hasOwn(v, k) ? v[k] : undefined;
    return typeof t === "string" && AUTH_CREDENTIAL_TYPES.has(t);
  });
  return typed && AUTH_CREDENTIAL_MEMBERS.some((m) => Object.hasOwn(v, m) && v[m] !== null && v[m] !== undefined);
}

/** Whether `v` is, or holds at any depth (arrays included), an ADK
 *  AuthCredential. Iterative and cycle-safe over the raw native value; a value
 *  that cannot be walked counts as holding one, so this never throws. */
function holdsAuthCredential(v: unknown): boolean {
  return holdsObject(v, isAuthCredentialObject);
}

/** Whether `v` is, or holds at any depth (arrays included), an object `match`
 *  accepts. Iterative and cycle-safe over the raw native value; a value that
 *  cannot be walked counts as holding one, so this never throws. */
function holdsObject(v: unknown, match: (o: { readonly [k: string]: unknown }) => boolean): boolean {
  try {
    const seen = new Set<object>();
    const stack: unknown[] = [v];
    while (stack.length > 0) {
      const x = stack.pop();
      if (x === null || typeof x !== "object" || seen.has(x)) continue;
      seen.add(x);
      if (Array.isArray(x)) {
        for (const y of x) stack.push(y);
      } else if (isObjectRecord(x)) {
        if (match(x)) return true;
        for (const k of Object.keys(x)) stack.push(x[k]);
      }
    }
    return false;
  } catch {
    return true;
  }
}

/** The state map ADK yields, minus its "temp:" entries and every entry that
 *  holds an ADK AuthCredential, in the original key order. A map with none of
 *  those is carried exactly as before. When entries were omitted, a remaining
 *  entry that is not JSON is dropped rather than thrown on, since a throw would
 *  hand the raw native event to the host's error path. A value that is not a
 *  map is carried as before, or as {} if it holds a credential. */
export function scrubStateMap(raw: unknown): JsonValue {
  if (!isObjectRecord(raw)) return holdsAuthCredential(raw) ? {} : JsonValue.parse(raw);
  const keys = Object.keys(raw);
  const omitted = keys.map((k) => k.startsWith(ADK_TEMP_STATE_PREFIX) || holdsAuthCredential(raw[k]));
  if (!omitted.includes(true)) return JsonValue.parse(raw);
  const kept: [string, JsonValue][] = [];
  keys.forEach((k, i) => {
    if (omitted[i] === true || isReservedMapKey(k)) return;
    const parsed = JsonValue.safeParse(raw[k]);
    if (parsed.success) kept.push([k, parsed.data]);
  });
  return Object.fromEntries(kept);
}

/** The ADK AuthConfig reduced to its non-secret members ({} for a non-object). */
export function scrubAdkAuthConfig(native: JsonValue): JsonValue {
  return pickAllowed(native, AUTH_CONFIG_ALLOW) ?? {};
}

/** A reserved-credential functionResponse (the client's answer) scrubbed the
 *  same way; undefined when the response is not an object. */
export function scrubbedResponse(response: unknown): { readonly [k: string]: JsonValue } | undefined {
  if (!isJsonObject(response)) return undefined;
  const scrubbed = scrubAdkAuthConfig(response);
  return isJsonObject(scrubbed) ? scrubbed : undefined;
}

// ─── provider-raw carries of node data ───────────────────────────────────────
// A Workflow event's `output` and `actions.agentState` ride verbatim in
// provider-raw. Inside them, each ADK AuthCredential (detected as for shared
// state) is reduced to its allowlisted members, and each response named
// adk_request_credential (matched by that name at any depth, never by id)
// keeps only its id, its name and the reserved-credential answer's
// allowlisted response, so an untyped reply becomes {}. Every other member
// rides unchanged. A value with neither is parsed exactly as before; a value
// that cannot be walked or reduced is omitted, never thrown on.

/** A response named adk_request_credential (a functionResponse object). */
function isCredentialRequestResponse(v: { readonly [k: string]: unknown }): boolean {
  return v["name"] === ADK_REQUEST_CREDENTIAL && Object.hasOwn(v, "name") && Object.hasOwn(v, "response");
}

/** One JSON value with every credential object and credential-request
 *  response reduced (see above); recursion stops at a reduced unit. */
function reduceCredentialCarry(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(reduceCredentialCarry);
  if (!isJsonObject(v)) return v;
  if (isAuthCredentialObject(v)) return pickAllowed(v, AUTH_CREDENTIAL_ALLOW) ?? {};
  if (isCredentialRequestResponse(v))
    return pickAllowed(v, { id: true, name: true, response: (r) => scrubbedResponse(r) }) ?? {};
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => !isReservedMapKey(k))
      .map(([k, x]): [string, JsonValue] => [k, reduceCredentialCarry(x)]),
  );
}

/** JSON with object keys in sorted order: "did the reduction change it"
 *  compares members, not the order an allowlist writes them in. */
function canonicalJson(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (!isJsonObject(v)) return JSON.stringify(v);
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k] ?? null)}`)
    .join(",")}}`;
}

/** A node-data value for a provider-raw carry. `changed` says whether the
 *  reduction altered it; `undefined` omits the unit. */
export function carryNodeValue(raw: unknown): { value: JsonValue; changed: boolean } | undefined {
  if (!holdsAuthCredential(raw) && !holdsObject(raw, isCredentialRequestResponse))
    return { value: JsonValue.parse(raw), changed: false };
  try {
    const before = JsonValue.parse(JSON.parse(JSON.stringify(raw)));
    const value = reduceCredentialCarry(before);
    return { value, changed: canonicalJson(value) !== canonicalJson(before) };
  } catch {
    return undefined;
  }
}

/** JSON.stringify of a raw `output` whose node-data reduction changed or
 *  omitted it: the text ADK renders from that output. `undefined` otherwise
 *  (including a string output, which ADK renders as itself). */
export function changedOutputRendering(output: unknown): string | undefined {
  if (output === undefined || output === null || typeof output !== "object") return undefined;
  // Detection first, so an output holding neither is never parsed here.
  if (!holdsAuthCredential(output) && !holdsObject(output, isCredentialRequestResponse)) return undefined;
  const carried = carryNodeValue(output);
  if (carried !== undefined && !carried.changed) return undefined;
  try {
    const rendered: unknown = JSON.stringify(output);
    return typeof rendered === "string" ? rendered : undefined;
  } catch {
    return undefined;
  }
}

/** The reserved credential call's args: its id, its message and the scrubbed
 *  AuthConfig. Nothing else is forwarded. */
export function scrubCredentialCallArgs(args: JsonValue): JsonValue {
  return (
    pickAllowed(args, {
      functionCallId: true,
      message: true,
      authConfig: (v) => scrubAdkAuthConfig(v),
    }) ?? {}
  );
}

export function adkAuthConfigView(native: JsonValue): AgAuthConfig | undefined {
  if (!isJsonObject(native)) return undefined;
  const authScheme = native["authScheme"];
  const scheme = stringMember(authScheme, "type");
  if (scheme === undefined || !isJsonObject(authScheme)) return undefined;
  let authorizationUrl: string | undefined;
  let tokenUrl: string | undefined;
  let scopes: string[] | undefined;
  if ("authorizationEndpoint" in authScheme) {
    authorizationUrl = stringMember(authScheme, "authorizationEndpoint");
    tokenUrl = stringMember(authScheme, "tokenEndpoint");
    const s = authScheme["scopes"];
    if (Array.isArray(s)) scopes = s.filter((x): x is string => typeof x === "string");
  } else if (scheme === "oauth2") {
    const flows = authScheme["flows"];
    const flow = isJsonObject(flows)
      ? [flows["implicit"], flows["authorizationCode"], flows["clientCredentials"], flows["password"]].find(
          isJsonObject,
        )
      : undefined;
    if (flow !== undefined) {
      authorizationUrl = stringMember(flow, "authorizationUrl");
      tokenUrl = stringMember(flow, "tokenUrl");
      const s = flow["scopes"];
      if (isJsonObject(s)) scopes = Object.keys(s);
    }
  }
  const raw = native["rawAuthCredential"];
  const oauth2 = isJsonObject(raw) ? raw["oauth2"] : undefined;
  const clientId = stringMember(oauth2, "clientId");
  const audience = stringMember(oauth2, "audience");
  return {
    scheme,
    ...(scopes !== undefined ? { scopes } : {}),
    ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
    ...(tokenUrl !== undefined ? { tokenUrl } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(audience !== undefined ? { audience } : {}),
  };
}
