/** Protocols the Host can create for a new provider without provider-specific SDK auth. */
export const CUSTOM_PROVIDER_APIS = Object.freeze(
  /** @type {const} */ ([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ]),
);

/** Pi SDK 1.4 MCP exposure values; shared by config validation and the renderer. */
export const MCP_EXPOSURES = Object.freeze(
  /** @type {const} */ (["codemode", "deferred", "direct", "hidden"]),
);
