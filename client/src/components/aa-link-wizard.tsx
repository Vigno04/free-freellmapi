import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, Search } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/confirm-button'
import { Dialog, DialogPopup, DialogTrigger, DialogTitle, DialogDescription, DialogClose } from '@/components/ui/dialog'
import { ModelCombobox } from '@/components/model-combobox'
import { toast } from '@/lib/toast'

export function AALinkWizard() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)

  const { data, isLoading } = useQuery<{ aaModels: any[]; baseModels: any[] }>({
    queryKey: ['settings', 'artificial-analysis-models'],
    queryFn: () => apiFetch('/api/settings/artificial-analysis/models'),
  })

  const linkMutation = useMutation({
    mutationFn: ({ base_model_id, aa_id, aa_slug }: any) =>
      apiFetch('/api/settings/artificial-analysis/link', {
        method: 'POST',
        body: JSON.stringify({ base_model_id, aa_id, aa_slug }),
      }),
    onSuccess: () => {
      toast.success('Link updated successfully')
      queryClient.invalidateQueries({ queryKey: ['settings', 'artificial-analysis-models'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['catalogs'] })
    },
    onError: (err: any) => {
      toast.error(err.message || 'Failed to update link')
    }
  })

  const resetMutation = useMutation({
    mutationFn: () => apiFetch('/api/settings/artificial-analysis/reset-links', { method: 'POST' }),
    onSuccess: (res: any) => {
      toast.success(`Reset ${res.reset_count} manual links. You can now re-run Sync.`)
      queryClient.invalidateQueries({ queryKey: ['settings', 'artificial-analysis-models'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['catalogs'] })
    },
    onError: (err: any) => toast.error(err.message || 'Failed to reset links')
  })

  const handleLink = (baseModel: any, aaSlug: string | null) => {
    let aaId = null
    if (aaSlug) {
       const m = data?.aaModels.find(a => a.slug === aaSlug)
       if (m) aaId = m.id
    }
    linkMutation.mutate({ base_model_id: baseModel.id, aa_id: aaId, aa_slug: aaSlug })
  }

  const baseList = useMemo(() => {
    if (!data) return []
    let list = data.baseModels.map(bm => {
       let matchedAa = null
       if (bm.aa_slug) {
         matchedAa = data.aaModels.find((a: any) => a.slug === bm.aa_slug)
       }
       return { ...bm, matchedAa }
    })
    
    if (unlinkedOnly) {
       list = list.filter((bm: any) => !bm.aa_slug && !bm.pricing_json)
    }
    
    if (search.trim()) {
       const q = search.toLowerCase()
       list = list.filter((bm: any) => 
         bm.canonical_id.toLowerCase().includes(q) || 
         bm.group_label.toLowerCase().includes(q)
       )
    }
    
    return list
  }, [data, unlinkedOnly, search])

  const comboOptions = useMemo(() => {
    if (!data) return []
    return [
      { value: 'none', label: 'Unlinked / Fuzzy Matched', sub: 'Clear manual link' },
      ...data.aaModels.map((aa: any) => ({
        value: aa.slug,
        label: aa.name,
        sub: aa.slug
      }))
    ]
  }, [data])

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" disabled={isLoading} />}>
        <Link2 className="size-4 mr-2" />
        Manage Model Links
      </DialogTrigger>

      <DialogPopup maxWidth="max-w-4xl" className="flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div>
            <DialogTitle>Manage Artificial Analysis Links</DialogTitle>
            <DialogDescription>
              Explicitly bind local models to Artificial Analysis IDs. 
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <ConfirmButton 
               variant="outline" 
               size="sm" 
               confirmLabel="Confirm Reset" 
               onConfirm={() => resetMutation.mutate()}
               disabled={resetMutation.isPending}
            >
               Reset All Manual Links
            </ConfirmButton>
            <DialogClose render={<Button variant="ghost" size="sm" />}>
               Close
            </DialogClose>
          </div>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground text-sm animate-pulse">Loading models...</div>
        ) : (
          <div className="flex flex-col overflow-hidden gap-4 min-h-0 h-[600px]">
            <div className="flex items-center gap-4 shrink-0">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input 
                  placeholder="Search local models..." 
                  value={search} 
                  onChange={e => setSearch(e.target.value)} 
                  className="pl-9"
                />
              </div>
              <label className="flex items-center gap-2 text-sm select-none cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={unlinkedOnly} 
                  onChange={e => setUnlinkedOnly(e.target.checked)}
                  className="rounded border-input text-primary focus:ring-primary" 
                />
                Unlinked Only
              </label>
            </div>

            <div className="overflow-y-auto min-h-0 border rounded-md">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-muted-foreground bg-muted/50 sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="px-4 py-2 font-medium">Local Model</th>
                    <th className="px-4 py-2 font-medium">Linked AA Model</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {baseList.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-8 text-center text-muted-foreground">
                        No base models found matching criteria.
                      </td>
                    </tr>
                  ) : baseList.map((bm: any) => (
                    <tr key={bm.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium">{bm.group_label}</div>
                        <div className="text-xs text-muted-foreground font-mono mt-1 opacity-70">
                          {bm.canonical_id}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top min-w-[300px]">
                        <ModelCombobox 
                           value={bm.matchedAa?.slug || 'none'} 
                           options={comboOptions}
                           onSelect={(val) => handleLink(bm, val === 'none' ? null : val)}
                           ariaLabel="Select AA Model"
                           placeholder="Search catalog..."
                           emptyText="No models found."
                           triggerClassName="flex h-8 w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            <div className="text-xs text-muted-foreground flex justify-between shrink-0">
               <span>Showing {baseList.length} base models.</span>
               <span>Total AA Catalog: {data?.aaModels.length || 0}</span>
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
