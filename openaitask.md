# OpenAI Auth Implementation Tasks

Phase 1 - Discovery and Preparation
[x] T1.1 Confirm current LLM provider flow in `src/app/api/llm/route.ts` and `src/components/nodes/LLMGenerateNode.tsx`.
[x] T1.2 Review provider settings UI in `src/components/ProjectSetupModal.tsx` for placement of OpenAI Auth controls.
[x] T1.3 Verify existing provider settings persistence in `src/store/utils/localStorage.ts` and types in `src/types/providers.ts`.
[x] T1.4 Add `data/` to `.gitignore` for server-side token storage.

Phase 2 - Types and Provider Options
[x] T2.1 Extend `LLMProvider` to include `openai-auth` in `src/types/providers.ts`.
[x] T2.2 Update `LLMGenerateRequest` provider typing in `src/types/api.ts`.
[x] T2.3 Add `OpenAI (Auth)` to provider lists in `src/components/nodes/LLMGenerateNode.tsx` and `src/components/ProjectSetupModal.tsx`.
[x] T2.4 Ensure model lists for `openai-auth` match OpenAI model options.

Phase 3 - Server-Side Token Storage
[ ] T3.1 Create `src/lib/auth/openaiAuthStore.ts` to read/write tokens in `data/openai-auth.json`.
[ ] T3.2 Store fields: access_token, refresh_token, expires_at, scope, account_id, created_at, updated_at, state, code_verifier.
[ ] T3.3 Add helper to check expiry and refresh with OpenAI token endpoint.

Phase 4 - OAuth Routes
[ ] T4.1 Implement `GET /api/auth/openai/start` to generate PKCE + state and return auth URL.
[ ] T4.2 Implement `GET /api/auth/openai/callback` to exchange code, persist tokens, and redirect to success UI.
[ ] T4.3 Implement `GET /api/auth/openai/status` to report connection state and expiry.
[ ] T4.4 Implement `POST /api/auth/openai/disconnect` to clear stored tokens.

Phase 5 - LLM Request Integration
[ ] T5.1 Update `src/app/api/llm/route.ts` to accept `openai-auth` provider.
[ ] T5.2 Load and refresh tokens from `data/openai-auth.json` as needed.
[ ] T5.3 Send OpenAI requests with `Authorization: Bearer <access_token>`.
[ ] T5.4 Preserve existing API-key flow for `openai` and `google` providers.

Phase 6 - UI Integration
[ ] T6.1 Add Connect/Disconnect buttons for OpenAI Auth in `src/components/ProjectSetupModal.tsx`.
[ ] T6.2 Show connection status in Providers tab via `/api/auth/openai/status`.
[ ] T6.3 Add warning or badge in `LLMGenerateNode` if `openai-auth` selected but not connected.

Phase 7 - Validation
[ ] T7.1 Manual test: connect -> generate -> disconnect.
[ ] T7.2 Test expired token refresh flow.
[ ] T7.3 Verify API key flows still work for existing providers.
