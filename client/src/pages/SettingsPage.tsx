import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, RefreshCw, Key } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { toast } from '@/lib/toast'
import { AALinkWizard } from '@/components/aa-link-wizard'
import { Switch } from '@/components/ui/switch'

interface ExposedModelsConfig {
  singular: boolean;
  fusion: boolean;
  autoBalanced: boolean;
  autoIntelligent: boolean;
  autoFast: boolean;
}

export default function SettingsPage() {
  const queryClient = useQueryClient()
  const [apiKey, setApiKey] = useState('')

  const { data: keyData, isLoading: isLoadingKey } = useQuery<{ hasKey: boolean; maskedKey?: string }>({
    queryKey: ['settings', 'artificial-analysis-key'],
    queryFn: () => apiFetch('/api/settings/artificial-analysis/key'),
  })

  useEffect(() => {
    if (keyData?.hasKey && keyData.maskedKey) {
      setApiKey(keyData.maskedKey)
    }
  }, [keyData])

  const saveMutation = useMutation({
    mutationFn: (key: string) =>
      apiFetch('/api/settings/artificial-analysis/key', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: key }),
      }),
    onSuccess: () => {
      toast.success('API Key saved')
      queryClient.invalidateQueries({ queryKey: ['settings', 'artificial-analysis-key'] })
    },
  })

  const syncMutation = useMutation({
    mutationFn: (action: string) =>
      apiFetch('/api/settings/artificial-analysis/test', {
        method: 'POST',
        body: JSON.stringify({ action }),
      }),
    onSuccess: (data: any, action: string) => {
      let msg = ''
      if (action === 'refresh_list') {
        msg = `Successfully fetched ${data.count} models.`
      } else {
        msg = `Successfully fetched ${data.count} models and applied ${data.applied_updates} local overrides.`
      }
      toast.success(msg)
      // Refresh models table to show the new data
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['catalogs'] })
      queryClient.invalidateQueries({ queryKey: ['settings', 'artificial-analysis-models'] })
    },
  })

  function handleSave() {
    if (!apiKey.trim() || apiKey.includes('***')) return
    saveMutation.mutate(apiKey.trim())
  }

  function handleAction(action: string) {
    syncMutation.mutate(action)
  }

  return (
    <div>
      <PageHeader title="Settings" description="Manage global settings and integrations." divider={true} />

      <div className="space-y-6">
        <ExposedModelsPanel />

        <div className="rounded-2xl border bg-card p-6">
          <div className="mb-4">
            <h2 className="text-lg font-medium flex items-center gap-2">
              <Key className="size-5" />
              Artificial Analysis Integration
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Configure your Artificial Analysis API key to fetch independent model benchmarks, pricing, and live performance data.
            </p>
          </div>

          <div className="grid gap-4 max-w-xl">
            <div className="space-y-2">
              <label className="text-sm font-medium">API Key</label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="aa_..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="font-mono text-sm"
                  disabled={isLoadingKey}
                />
                <Button onClick={handleSave} disabled={saveMutation.isPending || !apiKey.trim() || apiKey.includes('***')}>
                  <Save className="size-4 mr-2" />
                  Save
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 mt-4">
              <Button onClick={() => handleAction('refresh_list')} disabled={syncMutation.isPending || !keyData?.hasKey} variant="secondary" size="sm">
                <RefreshCw className={`size-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                Refresh List
              </Button>
              <Button onClick={() => handleAction('link')} disabled={syncMutation.isPending || !keyData?.hasKey} variant="secondary" size="sm">
                Run Linking
              </Button>
              <Button onClick={() => handleAction('refresh_data')} disabled={syncMutation.isPending || !keyData?.hasKey} variant="secondary" size="sm">
                Refresh Data
              </Button>
              <Button onClick={() => handleAction('reset_model')} disabled={syncMutation.isPending || !keyData?.hasKey} variant="destructive" size="sm">
                Reset Model
              </Button>
              {keyData?.hasKey && <AALinkWizard />}
            </div>
            
            {syncMutation.data && syncMutation.variables !== 'refresh_list' && (
               <div className="mt-4 rounded-xl border p-4 bg-muted/50">
                 <h3 className="text-sm font-medium mb-2">Sync Results</h3>
                 <p className="text-xs text-muted-foreground mb-4">
                   Found {syncMutation.data.count} models. Updated {syncMutation.data.applied_updates} local overrides.
                 </p>
                 <div className="max-h-48 overflow-y-auto space-y-2 text-xs font-mono">
                   {syncMutation.data.models.map((m: any) => (
                     <div key={m.id} className="flex justify-between items-center bg-background p-2 rounded border">
                       <span className="font-medium truncate flex-1">{m.name}</span>
                       <span className="text-muted-foreground shrink-0 ml-4">
                         {m.creator && `Creator: ${m.creator} `}
                         {m.intelligenceRank && `Elo: ${m.intelligenceRank} `}
                       </span>
                     </div>
                   ))}
                 </div>
               </div>
            )}
          </div>

          <div className="mt-8 border-t pt-6 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Model scores, speeds, and benchmarks are sourced from Artificial Analysis.
            </p>
            <a 
              href="https://artificialanalysis.ai" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs font-medium text-foreground hover:underline flex items-center gap-1 opacity-80 transition-opacity hover:opacity-100"
            >
              Powered by Artificial Analysis
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function ExposedModelsPanel() {
  const queryClient = useQueryClient()
  const { data: exposed, isLoading } = useQuery<ExposedModelsConfig>({
    queryKey: ['settings', 'exposed-models'],
    queryFn: () => apiFetch('/api/settings/exposed-models'),
  })

  const updateMutation = useMutation({
    mutationFn: (newExposed: ExposedModelsConfig) =>
      apiFetch('/api/settings/exposed-models', {
        method: 'PUT',
        body: JSON.stringify(newExposed),
      }),
    onSuccess: () => {
      toast.success('Exposed models updated')
      queryClient.invalidateQueries({ queryKey: ['settings', 'exposed-models'] })
    },
  })

  if (isLoading) return null

  const handleToggle = (key: string, checked: boolean) => {
    if (!exposed) return
    updateMutation.mutate({ ...exposed, [key]: checked })
  }

  return (
    <div className="rounded-2xl border bg-card p-6">
      <div className="mb-4">
        <h2 className="text-lg font-medium flex items-center gap-2">
          API Exposed Models
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select which models should be exposed in the /v1/models endpoint for API clients.
        </p>
      </div>

      <div className="grid gap-4 max-w-xl">
        <label className="flex items-center space-x-3 cursor-pointer">
          <Switch 
            checked={exposed?.singular ?? true} 
            onCheckedChange={(c: boolean) => handleToggle('singular', c)} 
          />
          <span className="text-sm font-medium">Singular Models</span>
        </label>
        
        <label className="flex items-center space-x-3 cursor-pointer">
          <Switch 
            checked={exposed?.fusion ?? true} 
            onCheckedChange={(c: boolean) => handleToggle('fusion', c)} 
          />
          <span className="text-sm font-medium">Fusion</span>
        </label>

        <label className="flex items-center space-x-3 cursor-pointer">
          <Switch 
            checked={exposed?.autoBalanced ?? true} 
            onCheckedChange={(c: boolean) => handleToggle('autoBalanced', c)} 
          />
          <span className="text-sm font-medium">Auto (Balanced)</span>
        </label>

        <label className="flex items-center space-x-3 cursor-pointer">
          <Switch 
            checked={exposed?.autoIntelligent ?? true} 
            onCheckedChange={(c: boolean) => handleToggle('autoIntelligent', c)} 
          />
          <span className="text-sm font-medium">Auto (Intelligent)</span>
        </label>

        <label className="flex items-center space-x-3 cursor-pointer">
          <Switch 
            checked={exposed?.autoFast ?? true} 
            onCheckedChange={(c: boolean) => handleToggle('autoFast', c)} 
          />
          <span className="text-sm font-medium">Auto (Fast)</span>
        </label>
      </div>
    </div>
  )
}
