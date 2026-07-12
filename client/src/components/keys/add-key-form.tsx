import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldError } from '@/components/ui/field-error'
import type { Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS, type HealthData } from './shared'

// The "Provider key" pane of the Add key dialog: paste a credential for a known
// provider. Extracted verbatim from the old inline KeysPage form so all field
// validation, the keyless/Cloudflare special cases, and the POST /api/keys
// mutation stay identical. On success it toasts and asks the dialog to close.
export function AddKeyForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [label, setLabel] = useState('')
  const [addAttempted, setAddAttempted] = useState(false)

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
  })

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string; baseUrl?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      toast.success(t('keys.keyAdded'))
      // Server notice when the key is for a platform with no models in the
      // current catalog tier yet (#438) — surfaced as a toast now that the
      // dialog closes on success.
      if (data?.notice) toast.info(data.notice)
      onSuccess()
    },
  })

  const needsAccountId = platform === 'cloudflare'
  const needsBaseUrl = platform === 'alibaba'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false

  // Field-level validation: the submit stays clickable and reveals what is
  // missing instead of being silently disabled.
  const platformError = !platform ? t('validation.required') : null
  const keyError = !isKeyless && !apiKey.trim() ? t('validation.required') : null
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null
  const baseUrlError = needsBaseUrl && !baseUrl.trim() ? t('validation.required') : null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (platformError || keyError || accountIdError || baseUrlError) {
      setAddAttempted(true)
      return
    }
    setAddAttempted(false)
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined, baseUrl: baseUrl || undefined })
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.platform')}</Label>
          <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
            <SelectTrigger className="w-[280px]" aria-invalid={addAttempted && !!platformError}>
              <SelectValue placeholder={t('keys.selectPlatform')} />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map(p => {
                const count = healthData?.platforms.find(x => x.platform === p.value)?.totalKeys || 0
                return (
                  <SelectItem key={p.value} value={p.value}>
                    <div className="flex flex-1 items-center justify-between w-full">
                      <span>{p.label}</span>
                      {count > 0 && <span className="text-muted-foreground text-xs ml-auto">{count}</span>}
                    </div>
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          {addAttempted && <FieldError error={platformError} />}
          {(() => {
            const sel = PLATFORMS.find(p => p.value === platform)
            return sel?.url ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
          })()}
        </div>
        {needsAccountId && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.accountId')}</Label>
            <Input
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="a1b2c3d4…"
              className="w-[200px] font-mono text-xs"
              aria-invalid={addAttempted && !!accountIdError}
            />
            {addAttempted && <FieldError error={accountIdError} />}
          </div>
        )}
        {needsBaseUrl && (
          <div className="space-y-1.5 flex-1 min-w-[240px]">
            <Label className="text-xs">{t('keys.customBaseUrl') ?? 'Base URL'}</Label>
            <Input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
              className="font-mono text-xs"
              aria-invalid={addAttempted && !!baseUrlError}
            />
            {addAttempted && <FieldError error={baseUrlError} />}
          </div>
        )}
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}</Label>
          <Input
            type="password"
            value={isKeyless ? '' : apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder={isKeyless ? t('keys.noKeyNeededPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
            className="font-mono text-xs"
            disabled={isKeyless}
            aria-invalid={addAttempted && !!keyError}
          />
          {addAttempted && <FieldError error={keyError} />}
          {isKeyless && (
            <p className="text-[11px] text-muted-foreground">
              {t('keys.keylessHint')}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.label')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[160px]"
            />
            <Button type="submit" size="sm" disabled={addKey.isPending}>
              {addKey.isPending ? t('keys.adding') : isKeyless ? t('keys.enable') : t('keys.addKey')}
            </Button>
          </div>
        </div>
      </form>
      {addKey.isError && (
        <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
      )}
    </div>
  )
}
