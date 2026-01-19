import { useState } from 'react';
import { useAppStore } from '@/store/app-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  Cloud,
  Eye,
  EyeOff,
  ExternalLink,
  MoreVertical,
  Pencil,
  Plus,
  Server,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ClaudeApiProfile, ApiKeySource } from '@automaker/types';
import { CLAUDE_API_PROFILE_TEMPLATES } from '@automaker/types';

// Generate unique ID for profiles
function generateProfileId(): string {
  return `profile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Mask API key for display (show first 4 + last 4 chars)
function maskApiKey(key?: string): string {
  if (!key || key.length <= 8) return '••••••••';
  return `${key.substring(0, 4)}••••${key.substring(key.length - 4)}`;
}

interface ProfileFormData {
  name: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKey: string;
  useAuthToken: boolean;
  timeoutMs: string; // String for input, convert to number
  modelMappings: {
    haiku: string;
    sonnet: string;
    opus: string;
  };
  disableNonessentialTraffic: boolean;
}

const emptyFormData: ProfileFormData = {
  name: '',
  baseUrl: '',
  apiKeySource: 'inline',
  apiKey: '',
  useAuthToken: false,
  timeoutMs: '',
  modelMappings: {
    haiku: '',
    sonnet: '',
    opus: '',
  },
  disableNonessentialTraffic: false,
};

export function ApiProfilesSection() {
  const {
    claudeApiProfiles,
    activeClaudeApiProfileId,
    addClaudeApiProfile,
    updateClaudeApiProfile,
    deleteClaudeApiProfile,
    setActiveClaudeApiProfile,
  } = useAppStore();

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [formData, setFormData] = useState<ProfileFormData>(emptyFormData);
  const [showApiKey, setShowApiKey] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [currentTemplate, setCurrentTemplate] = useState<
    (typeof CLAUDE_API_PROFILE_TEMPLATES)[0] | null
  >(null);

  const handleOpenAddDialog = (templateName?: string) => {
    const template = templateName
      ? CLAUDE_API_PROFILE_TEMPLATES.find((t) => t.name === templateName)
      : undefined;

    if (template) {
      setFormData({
        name: template.name,
        baseUrl: template.baseUrl,
        apiKeySource: template.defaultApiKeySource ?? 'inline',
        apiKey: '',
        useAuthToken: template.useAuthToken,
        timeoutMs: template.timeoutMs?.toString() ?? '',
        modelMappings: {
          haiku: template.modelMappings?.haiku ?? '',
          sonnet: template.modelMappings?.sonnet ?? '',
          opus: template.modelMappings?.opus ?? '',
        },
        disableNonessentialTraffic: template.disableNonessentialTraffic ?? false,
      });
      setCurrentTemplate(template);
    } else {
      setFormData(emptyFormData);
      setCurrentTemplate(null);
    }

    setEditingProfileId(null);
    setShowApiKey(false);
    setIsDialogOpen(true);
  };

  const handleOpenEditDialog = (profile: ClaudeApiProfile) => {
    // Find matching template by base URL
    const template = CLAUDE_API_PROFILE_TEMPLATES.find((t) => t.baseUrl === profile.baseUrl);

    setFormData({
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKeySource: profile.apiKeySource ?? 'inline',
      apiKey: profile.apiKey ?? '',
      useAuthToken: profile.useAuthToken ?? false,
      timeoutMs: profile.timeoutMs?.toString() ?? '',
      modelMappings: {
        haiku: profile.modelMappings?.haiku ?? '',
        sonnet: profile.modelMappings?.sonnet ?? '',
        opus: profile.modelMappings?.opus ?? '',
      },
      disableNonessentialTraffic: profile.disableNonessentialTraffic ?? false,
    });
    setEditingProfileId(profile.id);
    setCurrentTemplate(template ?? null);
    setShowApiKey(false);
    setIsDialogOpen(true);
  };

  const handleSave = () => {
    const profileData: ClaudeApiProfile = {
      id: editingProfileId ?? generateProfileId(),
      name: formData.name.trim(),
      baseUrl: formData.baseUrl.trim(),
      apiKeySource: formData.apiKeySource,
      // Only include apiKey when source is 'inline'
      apiKey: formData.apiKeySource === 'inline' ? formData.apiKey : undefined,
      useAuthToken: formData.useAuthToken,
      timeoutMs: (() => {
        const parsed = Number(formData.timeoutMs);
        return Number.isFinite(parsed) ? parsed : undefined;
      })(),
      modelMappings:
        formData.modelMappings.haiku || formData.modelMappings.sonnet || formData.modelMappings.opus
          ? {
              ...(formData.modelMappings.haiku && { haiku: formData.modelMappings.haiku }),
              ...(formData.modelMappings.sonnet && { sonnet: formData.modelMappings.sonnet }),
              ...(formData.modelMappings.opus && { opus: formData.modelMappings.opus }),
            }
          : undefined,
      disableNonessentialTraffic: formData.disableNonessentialTraffic || undefined,
    };

    if (editingProfileId) {
      updateClaudeApiProfile(editingProfileId, profileData);
    } else {
      addClaudeApiProfile(profileData);
    }

    setIsDialogOpen(false);
    setFormData(emptyFormData);
    setEditingProfileId(null);
  };

  const handleDelete = (id: string) => {
    deleteClaudeApiProfile(id);
    setDeleteConfirmId(null);
  };

  // Check for duplicate profile name (case-insensitive, excluding current profile when editing)
  const isDuplicateName = claudeApiProfiles.some(
    (p) => p.name.toLowerCase() === formData.name.trim().toLowerCase() && p.id !== editingProfileId
  );

  // API key is only required when source is 'inline'
  const isFormValid =
    formData.name.trim().length > 0 &&
    formData.baseUrl.trim().length > 0 &&
    (formData.apiKeySource !== 'inline' || formData.apiKey.length > 0) &&
    !isDuplicateName;

  return (
    <div
      className={cn(
        'rounded-2xl overflow-hidden',
        'border border-border/50',
        'bg-linear-to-br from-card/90 via-card/70 to-card/80 backdrop-blur-xl',
        'shadow-sm shadow-black/5'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-brand-500/10">
            <Server className="w-5 h-5 text-brand-500" />
          </div>
          <div>
            <h3 className="font-semibold text-foreground">API Profiles</h3>
            <p className="text-xs text-muted-foreground">Manage Claude-compatible API endpoints</p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="w-4 h-4" />
              Add Profile
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleOpenAddDialog()}>
              <Plus className="w-4 h-4 mr-2" />
              Custom Profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {CLAUDE_API_PROFILE_TEMPLATES.map((template) => (
              <DropdownMenuItem
                key={template.name}
                onClick={() => handleOpenAddDialog(template.name)}
              >
                <Zap className="w-4 h-4 mr-2" />
                {template.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content */}
      <div className="p-6 space-y-4">
        {/* Active Profile Selector */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Active Profile</Label>
          <Select
            value={activeClaudeApiProfileId ?? 'none'}
            onValueChange={(value) => setActiveClaudeApiProfile(value === 'none' ? null : value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select active profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-brand-500" />
                  Direct Anthropic API
                </div>
              </SelectItem>
              {claudeApiProfiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  <div className="flex items-center gap-2">
                    <Server className="w-4 h-4 text-muted-foreground" />
                    {profile.name}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {activeClaudeApiProfileId
              ? 'Using custom API endpoint'
              : 'Using direct Anthropic API (API key or Claude Max plan)'}
          </p>
        </div>

        {/* Profile List */}
        {claudeApiProfiles.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground border border-dashed border-border/50 rounded-lg">
            <Server className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No API profiles configured</p>
            <p className="text-xs mt-1">
              Add a profile to use alternative Claude-compatible endpoints
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {claudeApiProfiles.map((profile) => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                isActive={profile.id === activeClaudeApiProfileId}
                onEdit={() => handleOpenEditDialog(profile)}
                onDelete={() => setDeleteConfirmId(profile.id)}
                onSetActive={() => setActiveClaudeApiProfile(profile.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProfileId ? 'Edit API Profile' : 'Add API Profile'}</DialogTitle>
            <DialogDescription>
              Configure a Claude-compatible API endpoint. API keys are stored locally.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="profile-name">Profile Name</Label>
              <Input
                id="profile-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., z.AI GLM"
                className={isDuplicateName ? 'border-destructive' : ''}
              />
              {isDuplicateName && (
                <p className="text-xs text-destructive">A profile with this name already exists</p>
              )}
            </div>

            {/* Base URL */}
            <div className="space-y-2">
              <Label htmlFor="profile-base-url">API Base URL</Label>
              <Input
                id="profile-base-url"
                value={formData.baseUrl}
                onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </div>

            {/* API Key Source */}
            <div className="space-y-2">
              <Label>API Key Source</Label>
              <Select
                value={formData.apiKeySource}
                onValueChange={(value: ApiKeySource) =>
                  setFormData({ ...formData, apiKeySource: value })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select API key source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credentials">
                    Use saved API key (from Settings → API Keys)
                  </SelectItem>
                  <SelectItem value="env">Use environment variable (ANTHROPIC_API_KEY)</SelectItem>
                  <SelectItem value="inline">Enter key for this profile only</SelectItem>
                </SelectContent>
              </Select>
              {formData.apiKeySource === 'credentials' && (
                <p className="text-xs text-muted-foreground">
                  Will use the Anthropic key from Settings → API Keys
                </p>
              )}
              {formData.apiKeySource === 'env' && (
                <p className="text-xs text-muted-foreground">
                  Will use ANTHROPIC_API_KEY environment variable
                </p>
              )}
            </div>

            {/* API Key (only shown for inline source) */}
            {formData.apiKeySource === 'inline' && (
              <div className="space-y-2">
                <Label htmlFor="profile-api-key">API Key</Label>
                <div className="relative">
                  <Input
                    id="profile-api-key"
                    type={showApiKey ? 'text' : 'password'}
                    value={formData.apiKey}
                    onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                    placeholder="Enter API key"
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-3 text-muted-foreground hover:text-foreground hover:bg-transparent"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                </div>
                {currentTemplate?.apiKeyUrl && (
                  <a
                    href={currentTemplate.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-400"
                  >
                    Get API Key from {currentTemplate.name} <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            )}

            {/* Use Auth Token */}
            <div className="flex items-center justify-between py-2">
              <div>
                <Label htmlFor="use-auth-token" className="font-medium">
                  Use Auth Token
                </Label>
                <p className="text-xs text-muted-foreground">
                  Use ANTHROPIC_AUTH_TOKEN instead of ANTHROPIC_API_KEY
                </p>
              </div>
              <Switch
                id="use-auth-token"
                checked={formData.useAuthToken}
                onCheckedChange={(checked) => setFormData({ ...formData, useAuthToken: checked })}
              />
            </div>

            {/* Timeout */}
            <div className="space-y-2">
              <Label htmlFor="profile-timeout">Timeout (ms)</Label>
              <Input
                id="profile-timeout"
                type="number"
                value={formData.timeoutMs}
                onChange={(e) => setFormData({ ...formData, timeoutMs: e.target.value })}
                placeholder="Optional, e.g., 3000000"
              />
            </div>

            {/* Model Mappings */}
            <div className="space-y-3">
              <Label className="font-medium">Model Mappings (Optional)</Label>
              <p className="text-xs text-muted-foreground -mt-1">
                Map Claude model aliases to provider-specific model names
              </p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="model-haiku" className="text-xs">
                    Haiku
                  </Label>
                  <Input
                    id="model-haiku"
                    value={formData.modelMappings.haiku}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        modelMappings: { ...formData.modelMappings, haiku: e.target.value },
                      })
                    }
                    placeholder="e.g., GLM-4.5-Flash"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="model-sonnet" className="text-xs">
                    Sonnet
                  </Label>
                  <Input
                    id="model-sonnet"
                    value={formData.modelMappings.sonnet}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        modelMappings: { ...formData.modelMappings, sonnet: e.target.value },
                      })
                    }
                    placeholder="e.g., glm-4.7"
                    className="text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="model-opus" className="text-xs">
                    Opus
                  </Label>
                  <Input
                    id="model-opus"
                    value={formData.modelMappings.opus}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        modelMappings: { ...formData.modelMappings, opus: e.target.value },
                      })
                    }
                    placeholder="e.g., glm-4.7"
                    className="text-xs"
                  />
                </div>
              </div>
            </div>

            {/* Disable Non-essential Traffic */}
            <div className="flex items-center justify-between py-2">
              <div>
                <Label htmlFor="disable-traffic" className="font-medium">
                  Disable Non-essential Traffic
                </Label>
                <p className="text-xs text-muted-foreground">
                  Sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
                </p>
              </div>
              <Switch
                id="disable-traffic"
                checked={formData.disableNonessentialTraffic}
                onCheckedChange={(checked) =>
                  setFormData({ ...formData, disableNonessentialTraffic: checked })
                }
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!isFormValid}>
              {editingProfileId ? 'Save Changes' : 'Add Profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Profile?</DialogTitle>
            <DialogDescription>
              This will permanently delete the API profile. If this profile is currently active, you
              will be switched to direct Anthropic API.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProfileCardProps {
  profile: ClaudeApiProfile;
  isActive: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetActive: () => void;
}

function ProfileCard({ profile, isActive, onEdit, onDelete, onSetActive }: ProfileCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border p-4 transition-colors',
        isActive
          ? 'border-brand-500/50 bg-brand-500/5'
          : 'border-border/50 bg-card/50 hover:border-border'
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-foreground truncate">{profile.name}</h4>
            {isActive && (
              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-brand-500/20 text-brand-500">
                Active
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-1">{profile.baseUrl}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
            <span>Key: {maskApiKey(profile.apiKey)}</span>
            {profile.useAuthToken && <span>Auth Token</span>}
            {profile.timeoutMs && <span>Timeout: {(profile.timeoutMs / 1000).toFixed(0)}s</span>}
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0">
              <MoreVertical className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!isActive && (
              <DropdownMenuItem onClick={onSetActive}>
                <Zap className="w-4 h-4 mr-2" />
                Set Active
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onEdit}>
              <Pencil className="w-4 h-4 mr-2" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
