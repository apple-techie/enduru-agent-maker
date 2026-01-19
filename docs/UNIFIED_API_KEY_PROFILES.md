# Unified Claude API Key and Profile System

This document describes the implementation of a unified API key sourcing system for Claude API profiles, allowing flexible configuration of how API keys are resolved.

## Problem Statement

Previously, Automaker had two separate systems for configuring Claude API access:

1. **API Keys section** (`credentials.json`): Stored Anthropic API key, used when no profile was active
2. **API Profiles section** (`settings.json`): Stored alternative endpoint configs (e.g., z.AI GLM) with their own inline API keys

This created several issues:

- Users configured Anthropic key in one place, but alternative endpoints in another
- No way to create a "Direct Anthropic" profile that reused the stored credentials
- Environment variable detection didn't integrate with the profile system
- Duplicated API key entry when users wanted the same key for multiple configurations

## Solution Overview

The solution introduces a flexible `apiKeySource` field on Claude API profiles that determines where the API key is resolved from:

| Source        | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `inline`      | API key stored directly in the profile (legacy behavior, default) |
| `env`         | Uses `ANTHROPIC_API_KEY` environment variable                     |
| `credentials` | Uses the Anthropic key from Settings → API Keys                   |

This allows:

- A single API key to be shared across multiple profile configurations
- "Direct Anthropic" profile that references saved credentials
- Environment variable support for CI/CD and containerized deployments
- Backwards compatibility with existing inline key profiles

## Implementation Details

### Type Changes

#### New Type: `ApiKeySource`

```typescript
// libs/types/src/settings.ts
export type ApiKeySource = 'inline' | 'env' | 'credentials';
```

#### Updated Interface: `ClaudeApiProfile`

```typescript
export interface ClaudeApiProfile {
  id: string;
  name: string;
  baseUrl: string;

  // NEW: API key sourcing strategy (default: 'inline' for backwards compat)
  apiKeySource?: ApiKeySource;

  // Now optional - only required when apiKeySource = 'inline'
  apiKey?: string;

  // Existing fields unchanged...
  useAuthToken?: boolean;
  timeoutMs?: number;
  modelMappings?: { haiku?: string; sonnet?: string; opus?: string };
  disableNonessentialTraffic?: boolean;
}
```

#### Updated Interface: `ClaudeApiProfileTemplate`

```typescript
export interface ClaudeApiProfileTemplate {
  name: string;
  baseUrl: string;
  defaultApiKeySource?: ApiKeySource; // NEW: Suggested source for this template
  useAuthToken: boolean;
  // ... other fields
}
```

### Provider Templates

The following provider templates are available:

#### Direct Anthropic

```typescript
{
  name: 'Direct Anthropic',
  baseUrl: 'https://api.anthropic.com',
  defaultApiKeySource: 'credentials',
  useAuthToken: false,
  description: 'Standard Anthropic API with your API key',
  apiKeyUrl: 'https://console.anthropic.com/settings/keys',
}
```

#### OpenRouter

Access Claude and 300+ other models through OpenRouter's unified API.

```typescript
{
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api',
  defaultApiKeySource: 'inline',
  useAuthToken: true,
  description: 'Access Claude and 300+ models via OpenRouter',
  apiKeyUrl: 'https://openrouter.ai/keys',
}
```

**Notes:**

- Uses `ANTHROPIC_AUTH_TOKEN` with your OpenRouter API key
- No model mappings by default - OpenRouter auto-maps Anthropic models
- Can customize model mappings to use any OpenRouter-supported model (e.g., `openai/gpt-5.1-codex-max`)

#### z.AI GLM

```typescript
{
  name: 'z.AI GLM',
  baseUrl: 'https://api.z.ai/api/anthropic',
  defaultApiKeySource: 'inline',
  useAuthToken: true,
  timeoutMs: 3000000,
  modelMappings: {
    haiku: 'GLM-4.5-Air',
    sonnet: 'GLM-4.7',
    opus: 'GLM-4.7',
  },
  disableNonessentialTraffic: true,
  description: '3× usage at fraction of cost via GLM Coding Plan',
  apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
}
```

#### MiniMax

MiniMax M2.1 coding model with extended context support.

```typescript
{
  name: 'MiniMax',
  baseUrl: 'https://api.minimax.io/anthropic',
  defaultApiKeySource: 'inline',
  useAuthToken: true,
  timeoutMs: 3000000,
  modelMappings: {
    haiku: 'MiniMax-M2.1',
    sonnet: 'MiniMax-M2.1',
    opus: 'MiniMax-M2.1',
  },
  disableNonessentialTraffic: true,
  description: 'MiniMax M2.1 coding model with extended context',
  apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
}
```

#### MiniMax (China)

Same as MiniMax but using the China-region endpoint.

```typescript
{
  name: 'MiniMax (China)',
  baseUrl: 'https://api.minimaxi.com/anthropic',
  defaultApiKeySource: 'inline',
  useAuthToken: true,
  timeoutMs: 3000000,
  modelMappings: {
    haiku: 'MiniMax-M2.1',
    sonnet: 'MiniMax-M2.1',
    opus: 'MiniMax-M2.1',
  },
  disableNonessentialTraffic: true,
  description: 'MiniMax M2.1 for users in China',
  apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
}
```

### Server-Side Changes

#### 1. Environment Building (`claude-provider.ts`)

The `buildEnv()` function now resolves API keys based on the `apiKeySource`:

```typescript
function buildEnv(
  profile?: ClaudeApiProfile,
  credentials?: Credentials // NEW parameter
): Record<string, string | undefined> {
  if (profile) {
    // Resolve API key based on source strategy
    let apiKey: string | undefined;
    const source = profile.apiKeySource ?? 'inline';

    switch (source) {
      case 'inline':
        apiKey = profile.apiKey;
        break;
      case 'env':
        apiKey = process.env.ANTHROPIC_API_KEY;
        break;
      case 'credentials':
        apiKey = credentials?.apiKeys?.anthropic;
        break;
    }

    // ... rest of profile-based env building
  }
  // ... no-profile fallback
}
```

#### 2. Settings Helper (`settings-helpers.ts`)

The `getActiveClaudeApiProfile()` function now returns both profile and credentials:

```typescript
export interface ActiveClaudeApiProfileResult {
  profile: ClaudeApiProfile | undefined;
  credentials: Credentials | undefined;
}

export async function getActiveClaudeApiProfile(
  settingsService?: SettingsService | null,
  logPrefix = '[SettingsHelper]'
): Promise<ActiveClaudeApiProfileResult> {
  // Returns both profile and credentials for API key resolution
}
```

#### 3. Auto-Migration (`settings-service.ts`)

A v4→v5 migration automatically creates a "Direct Anthropic" profile for existing users:

```typescript
// Migration v4 -> v5: Auto-create "Direct Anthropic" profile
if (storedVersion < 5) {
  const credentials = await this.getCredentials();
  const hasAnthropicKey = !!credentials.apiKeys?.anthropic;
  const hasNoProfiles = !result.claudeApiProfiles?.length;
  const hasNoActiveProfile = !result.activeClaudeApiProfileId;

  if (hasAnthropicKey && hasNoProfiles && hasNoActiveProfile) {
    // Create "Direct Anthropic" profile with apiKeySource: 'credentials'
    // and set it as active
  }
}
```

#### 4. Updated Call Sites

All files that call `getActiveClaudeApiProfile()` were updated to:

1. Destructure both `profile` and `credentials` from the result
2. Pass `credentials` to the provider via `ExecuteOptions`

**Files updated:**

- `apps/server/src/services/agent-service.ts`
- `apps/server/src/services/auto-mode-service.ts` (2 locations)
- `apps/server/src/services/ideation-service.ts` (2 locations)
- `apps/server/src/providers/simple-query-service.ts`
- `apps/server/src/routes/enhance-prompt/routes/enhance.ts`
- `apps/server/src/routes/context/routes/describe-file.ts`
- `apps/server/src/routes/context/routes/describe-image.ts`
- `apps/server/src/routes/github/routes/validate-issue.ts`
- `apps/server/src/routes/worktree/routes/generate-commit-message.ts`
- `apps/server/src/routes/features/routes/generate-title.ts`
- `apps/server/src/routes/backlog-plan/generate-plan.ts`
- `apps/server/src/routes/app-spec/sync-spec.ts`
- `apps/server/src/routes/app-spec/generate-features-from-spec.ts`
- `apps/server/src/routes/app-spec/generate-spec.ts`
- `apps/server/src/routes/suggestions/generate-suggestions.ts`

### UI Changes

#### 1. Profile Form (`api-profiles-section.tsx`)

Added an API Key Source selector dropdown:

```tsx
<Select
  value={formData.apiKeySource}
  onValueChange={(value: ApiKeySource) => setFormData({ ...formData, apiKeySource: value })}
>
  <SelectContent>
    <SelectItem value="credentials">Use saved API key (from Settings → API Keys)</SelectItem>
    <SelectItem value="env">Use environment variable (ANTHROPIC_API_KEY)</SelectItem>
    <SelectItem value="inline">Enter key for this profile only</SelectItem>
  </SelectContent>
</Select>
```

The API Key input field is now conditionally rendered only when `apiKeySource === 'inline'`.

#### 2. API Keys Section (`api-keys-section.tsx`)

Added an informational note:

> API Keys saved here can be used by API Profiles with "credentials" as the API key source. This lets you share a single key across multiple profile configurations without re-entering it.

## User Flows

### New User Flow

1. Go to Settings → API Keys
2. Enter Anthropic API key and save
3. Go to Settings → Providers → Claude
4. Create new profile from "Direct Anthropic" template
5. API Key Source defaults to "credentials" - no need to re-enter key
6. Save profile and set as active

### Existing User Migration

When an existing user with an Anthropic API key (but no profiles) loads settings:

1. System detects v4→v5 migration needed
2. Automatically creates "Direct Anthropic" profile with `apiKeySource: 'credentials'`
3. Sets new profile as active
4. User's existing workflow continues to work seamlessly

### Environment Variable Flow

For CI/CD or containerized deployments:

1. Set `ANTHROPIC_API_KEY` in environment
2. Create profile with `apiKeySource: 'env'`
3. Profile will use the environment variable at runtime

## Backwards Compatibility

- Profiles without `apiKeySource` field default to `'inline'`
- Existing profiles with inline `apiKey` continue to work unchanged
- No changes to the credentials file format
- Settings version bumped from 4 to 5 (migration is additive)

## Files Changed

| File                                                | Changes                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `libs/types/src/settings.ts`                        | Added `ApiKeySource` type, updated `ClaudeApiProfile`, added Direct Anthropic template |
| `libs/types/src/provider.ts`                        | Added `credentials` field to `ExecuteOptions`                                          |
| `libs/types/src/index.ts`                           | Exported `ApiKeySource` type                                                           |
| `apps/server/src/providers/claude-provider.ts`      | Updated `buildEnv()` to resolve keys from different sources                            |
| `apps/server/src/lib/settings-helpers.ts`           | Updated return type to include credentials                                             |
| `apps/server/src/services/settings-service.ts`      | Added v4→v5 auto-migration                                                             |
| `apps/server/src/providers/simple-query-service.ts` | Added credentials passthrough                                                          |
| `apps/server/src/services/*.ts`                     | Updated to pass credentials                                                            |
| `apps/server/src/routes/**/*.ts`                    | Updated to pass credentials (15 files)                                                 |
| `apps/ui/src/.../api-profiles-section.tsx`          | Added API Key Source selector                                                          |
| `apps/ui/src/.../api-keys-section.tsx`              | Added profile usage note                                                               |

## Testing

To verify the implementation:

1. **New user flow**: Create "Direct Anthropic" profile, select `credentials` source, enter key in API Keys section → verify it works
2. **Existing user migration**: User with credentials.json key sees auto-created "Direct Anthropic" profile
3. **Env var support**: Create profile with `env` source, set ANTHROPIC_API_KEY → verify it works
4. **z.AI GLM unchanged**: Existing profiles with inline keys continue working
5. **Backwards compat**: Profiles without `apiKeySource` field default to `inline`

```bash
# Build and run
npm run build:packages
npm run dev:web

# Run server tests
npm run test:server
```

## Per-Project Profile Override

Projects can override the global Claude API profile selection, allowing different projects to use different endpoints or configurations.

### Configuration

In **Project Settings → Claude**, users can select:

| Option                   | Behavior                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| **Use Global Setting**   | Inherits the active profile from global settings (default)         |
| **Direct Anthropic API** | Explicitly uses direct Anthropic API, bypassing any global profile |
| **\<Profile Name\>**     | Uses that specific profile for this project only                   |

### Storage

The per-project setting is stored in `.automaker/settings.json`:

```json
{
  "activeClaudeApiProfileId": "profile-id-here"
}
```

- `undefined` (or key absent): Use global setting
- `null`: Explicitly use Direct Anthropic API
- `"<id>"`: Use specific profile by ID

### Implementation

The `getActiveClaudeApiProfile()` function accepts an optional `projectPath` parameter:

```typescript
export async function getActiveClaudeApiProfile(
  settingsService?: SettingsService | null,
  logPrefix = '[SettingsHelper]',
  projectPath?: string // Optional: check project settings first
): Promise<ActiveClaudeApiProfileResult>;
```

When `projectPath` is provided:

1. Project settings are checked first for `activeClaudeApiProfileId`
2. If project has a value (including `null`), that takes precedence
3. If project has no override (`undefined`), falls back to global setting

### Scope

**Important:** Per-project profiles only affect Claude model calls. When other providers are used (Codex, OpenCode, Cursor), the Claude API profile setting has no effect—those providers use their own configuration.

Affected operations when using Claude models:

- Agent chat and feature implementation
- Code analysis and suggestions
- Commit message generation
- Spec generation and sync
- Issue validation
- Backlog planning

### Use Cases

1. **Experimentation**: Test z.AI GLM or MiniMax on a side project while keeping production projects on Direct Anthropic
2. **Cost optimization**: Use cheaper endpoints for hobby projects, premium for work projects
3. **Regional compliance**: Use China endpoints for projects with data residency requirements

## Future Enhancements

Potential future improvements:

1. **UI indicators**: Show whether credentials/env key is configured when selecting those sources
2. **Validation**: Warn if selected source has no key configured
3. **Per-provider credentials**: Support different credential keys for different providers
4. **Key rotation**: Support for rotating keys without updating profiles
