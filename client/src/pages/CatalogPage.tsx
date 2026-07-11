import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Sparkles } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { FieldError } from '@/components/ui/field-error'
import { CardSkeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'

interface LicenseStatus {
  valid: boolean
  plan: 'annual' | 'lifetime' | null
  status: string | null
  expiresAt: string | null
  cancelAtPeriodEnd?: boolean
  reason?: string
  checkedAtMs: number
}

interface CatalogSyncState {
  baseUrl: string
  source: string
  appliedVersion: string | null
  appliedTier: string | null
  lastSyncMs: number | null
  lastError: string | null
}

interface CatalogStatus {
  hasKey: boolean
  maskedKey: string | null
  license: LicenseStatus | null
  catalog: CatalogSyncState
  totalModels: number
  interval: string
  fallbackSources: string[]
  siteUrl: string
}

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuGroup } from '@/components/ui/dropdown-menu'

function fmtWhen(ms: number | null): string | undefined {
  if (!ms) return undefined
  return new Date(ms).toLocaleString()
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

export default function CatalogPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [keyInput, setKeyInput] = useState('')
  const [activateAttempted, setActivateAttempted] = useState(false)

  const { data, isLoading } = useQuery<CatalogStatus>({
    queryKey: ['catalogs'],
    queryFn: () => apiFetch('/api/catalogs'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['catalogs'] })
    // A sync may have changed the model list and quirks.
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const activate = useMutation({
    meta: { silenceToast: true },
    mutationFn: (key: string) =>
      apiFetch('/api/catalogs/key', { method: 'POST', body: JSON.stringify({ key }) }),
    onSuccess: () => {
      setKeyInput('')
      invalidate()
    },
  })

  const removeKey = useMutation({
    mutationFn: () => apiFetch('/api/catalogs/key', { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const syncNow = useMutation({
    mutationFn: (source?: string) => apiFetch('/api/catalogs/sync', { method: 'POST', body: source ? JSON.stringify({ source }) : undefined }),
    onSuccess: invalidate,
  })

  const setSyncInterval = useMutation({
    mutationFn: (interval: string) => apiFetch('/api/catalogs/interval', { method: 'POST', body: JSON.stringify({ interval }) }),
    onSuccess: invalidate,
  })

  const setFallbacks = useMutation({
    mutationFn: (sources: string[]) => apiFetch('/api/catalogs/fallbacks', { method: 'POST', body: JSON.stringify({ sources }) }),
    onSuccess: invalidate,
  })

  const openPortal = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch<{ url: string }>('/api/catalogs/portal', { method: 'POST' }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener')
    },
  })

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title={t('catalog.title')} description={t('catalog.description')} />
        <div className="space-y-6">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    )
  }

  const { hasKey, maskedKey, license, catalog, totalModels, siteUrl } = data
  const live = catalog.appliedTier === 'live'
  const licensed = hasKey && license?.valid

  return (
    <div>
      <PageHeader
        title={t('catalog.title')}
        description={t('catalog.description')}
        actions={
          <Button variant="outline" size="sm" onClick={() => syncNow.mutate(undefined)} disabled={syncNow.isPending}>
            <RefreshCw className={syncNow.isPending ? 'animate-spin' : ''} />
            {syncNow.isPending ? t('catalog.syncing') : t('catalog.checkForUpdates')}
          </Button>
        }
      />

      <div className="space-y-8">
        {/* Catalog source state */}
        <section>
          <h2 className="text-sm font-medium mb-3">{t('catalog.sourceTitle')}</h2>
          <div className="rounded-3xl border bg-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="flex items-center gap-4">
                <Select
                  value={catalog.source}
                  onValueChange={(val) => syncNow.mutate(val || undefined)}
                  disabled={syncNow.isPending}
                >
                  <SelectTrigger className="w-[280px]">
                    <SelectValue placeholder="Select a catalog source" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default Premium Catalog</SelectItem>
                    <SelectItem value="freellm">Awesome Free LLM APIs (freellm.net)</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={data.interval}
                  onValueChange={(val) => setSyncInterval.mutate(val || '12h')}
                  disabled={setSyncInterval.isPending}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Update Frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="12h">Every 12 Hours</SelectItem>
                    <SelectItem value="24h">Every 24 Hours</SelectItem>
                    <SelectItem value="72h">Every 72 Hours</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
                <DropdownMenu>
                  <DropdownMenuTrigger>
                    <Button variant="outline" size="sm" className="h-10 border-dashed" disabled={setFallbacks.isPending}>
                      Hybrid Fallbacks {data.fallbackSources.length > 0 ? `(${data.fallbackSources.length})` : ''}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-64">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Use missing data from...</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuCheckboxItem
                        checked={data.fallbackSources.includes('default')}
                        disabled={catalog.source === 'default'}
                      onCheckedChange={(checked) => {
                        const current = new Set(data.fallbackSources);
                        if (checked) current.add('default'); else current.delete('default');
                        setFallbacks.mutate(Array.from(current));
                      }}
                    >
                      Default Premium Catalog
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={data.fallbackSources.includes('freellm')}
                      disabled={catalog.source === 'freellm'}
                      onCheckedChange={(checked) => {
                        const current = new Set(data.fallbackSources);
                        if (checked) current.add('freellm'); else current.delete('freellm');
                        setFallbacks.mutate(Array.from(current));
                      }}
                    >
                      Awesome Free LLM APIs
                    </DropdownMenuCheckboxItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Badge variant="secondary" className="font-mono text-[12px]">
                  {totalModels} {t('catalog.modelsAvailable')}
                </Badge>
              </div>
              <span className="text-xs text-muted-foreground">{t('catalog.lastChecked', { when: fmtWhen(catalog.lastSyncMs) ?? t('common.never') })}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              {catalog.source === 'freellm' 
                ? 'Pulling the complete list of 600+ free models directly from freellm.net.'
                : live
                  ? t('catalog.liveDescription')
                  : t('catalog.snapshotDescription')}
            </p>
            {catalog.lastError && (
              <p className="text-destructive text-xs mt-2">{t('catalog.lastSyncProblem', { error: catalog.lastError })}</p>
            )}
          </div>
        </section>

        {/* License */}
        {catalog.source === 'default' && (
        <section>
          <h2 className="text-sm font-medium mb-3">{t('catalog.license')}</h2>
          {hasKey ? (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{maskedKey}</span>
                {licensed ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent">
                    {license?.plan === 'annual'
                      ? t('catalog.planAnnual')
                      : license?.plan === 'lifetime'
                        ? t('catalog.planLifetime')
                        : t('catalog.planGeneric')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/40">
                    {license?.reason === 'expired' ? t('catalog.expired') : t('catalog.inactive')}
                  </Badge>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {licensed && license?.plan === 'lifetime' && t('catalog.lifetimeNote')}
                {licensed && license?.plan === 'annual' && !license.cancelAtPeriodEnd && license.expiresAt &&
                  t('catalog.renewsOn', { date: fmtDate(license.expiresAt) })}
                {licensed && license?.plan === 'annual' && license.cancelAtPeriodEnd && license.expiresAt &&
                  t('catalog.willNotRenew', { date: fmtDate(license.expiresAt) })}
                {!licensed &&
                  t('catalog.keyInactive')}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
                  <ExternalLink />
                  {openPortal.isPending ? t('catalog.openingPortal') : t('catalog.manageSubscription')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeKey.mutate()}
                  disabled={removeKey.isPending}
                  className="text-muted-foreground"
                >
                  {t('catalog.removeKey')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('catalog.manageHint')}
              </p>
              {openPortal.isError && (
                <p className="text-destructive text-xs">{(openPortal.error as Error).message}</p>
              )}
            </div>
          ) : (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!keyInput.trim()) {
                    setActivateAttempted(true)
                    return
                  }
                  setActivateAttempted(false)
                  activate.mutate(keyInput.trim())
                }}
              >
                <div className="space-y-1.5 flex-1 min-w-[260px]">
                  <Label className="text-xs">{t('catalog.licenseKey')}</Label>
                  <Input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    className="font-mono text-xs"
                    autoComplete="off"
                    aria-invalid={activateAttempted && !keyInput.trim()}
                  />
                  {activateAttempted && !keyInput.trim() && <FieldError error={t('validation.required')} />}
                </div>
                <Button type="submit" size="sm" disabled={activate.isPending}>
                  {activate.isPending ? t('catalog.activating') : t('catalog.activate')}
                </Button>
              </form>
              {activate.isError && (
                <p className="text-destructive text-xs">{(activate.error as Error).message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('catalog.keyHint')}{' '}
                <a className="underline hover:text-foreground" href={`${siteUrl}/manage.html`} target="_blank" rel="noopener noreferrer">
                  {t('catalog.recoverKey')}
                </a>
                .
              </p>
            </div>
          )}
        </section>
        )}

        {/* Upsell, only when not licensed */}
        {catalog.source === 'default' && !licensed && (
          <section>
            <div className="rounded-3xl border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Sparkles className="size-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{t('catalog.upsellTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('catalog.upsellDescription')}
                  </p>
                </div>
              </div>
              <a
                href={`${siteUrl}/#pricing`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
              >
                <Button size="sm">
                  {t('catalog.goPremium')}
                  <ExternalLink />
                </Button>
              </a>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
