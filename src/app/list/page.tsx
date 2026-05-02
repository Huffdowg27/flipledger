'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { Plus, Package, Trash2 } from 'lucide-react';

interface BatchRow {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  inboundPlanId: string | null;
  createdAt: string;
  updatedAt: string;
  totalUnits: number;
  skuCount: number;
  expectedRevenue: number;
  totalCost: number;
  estimatedFees: number;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft:     'bg-bg-elevated text-text-secondary border-border-default',
    sending:   'bg-accent/10 text-accent border-accent/30',
    ready:     'bg-positive/10 text-positive border-positive/20',
    failed:    'bg-negative/10 text-negative border-negative/30',
    boxing:    'bg-amber-500/10 text-amber-400 border-amber-500/20',
    placement: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    shipping:  'bg-blue-500/10 text-blue-400 border-blue-500/20',
    shipped:   'bg-positive/10 text-positive border-positive/20',
    closed:    'bg-text-tertiary/10 text-text-tertiary border-text-tertiary/20',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${map[status] || map.draft}`}>
      {status}
    </span>
  );
}

export default function BatchesPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<'FBA' | 'MFN'>('FBA');
  const [creating, setCreating] = useState(false);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/list/batches');
      const data = await res.json();
      setBatches(data.batches || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchBatches(); }, [fetchBatches]);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/list/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), channel }),
      });
      const data = await res.json();
      if (data.id) {
        window.location.href = `/list/${data.id}`;
      }
    } catch (err) {
      console.error(err);
    }
    setCreating(false);
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this draft batch? This cannot be undone.')) return;
    try {
      await fetch(`/api/list/batches/${id}`, { method: 'DELETE' });
      fetchBatches();
    } catch (err) {
      console.error(err);
    }
  }

  function defaultName() {
    const d = new Date();
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} Batch`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Listing Batches</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Create, prep, and ship inventory to Amazon</p>
        </div>
        <button
          onClick={() => { setName(defaultName()); setShowNew(true); }}
          className="flex items-center gap-2 h-9 px-3 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          <Plus size={16} />
          New Batch
        </button>
      </div>

      {/* Batch list */}
      {loading ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-8 text-center text-text-tertiary">
          Loading batches…
        </div>
      ) : batches.length === 0 ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-12 text-center">
          <Package size={48} className="mx-auto text-text-tertiary mb-3" />
          <h3 className="text-base font-medium text-text-primary mb-1">No batches yet</h3>
          <p className="text-sm text-text-tertiary mb-4">Create your first batch to start listing inventory.</p>
          <button
            onClick={() => { setName(defaultName()); setShowNew(true); }}
            className="inline-flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            <Plus size={16} />
            New Batch
          </button>
        </div>
      ) : (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-elevated">
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Name</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Status</th>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">Channel</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">SKUs</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">Units</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Expected Rev</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Cost</th>
                <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Updated</th>
                <th className="px-2 py-2.5 text-right border-b border-border-subtle w-10"></th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                  <td className="px-4 py-2">
                    <Link href={`/list/${b.id}`} className="text-sm text-text-primary font-medium hover:text-accent">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2"><StatusBadge status={b.status} /></td>
                  <td className="px-4 py-2 text-sm text-text-secondary">{b.channel}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{b.skuCount}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{b.totalUnits}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">{formatCurrency(b.expectedRevenue)}</td>
                  <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{formatCurrency(b.totalCost)}</td>
                  <td className="px-4 py-2 text-right text-xs text-text-tertiary">{new Date(b.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  <td className="px-2 py-2 text-right">
                    {b.status === 'draft' && (
                      <button
                        onClick={() => handleDelete(b.id)}
                        className="p-1 text-text-tertiary hover:text-negative transition-colors"
                        title="Delete draft"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* New Batch modal */}
      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowNew(false)}>
          <div className="bg-bg-surface border border-border-default rounded-lg p-5 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold mb-4">New Batch</h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-text-tertiary uppercase tracking-wide">Batch Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  className="w-full mt-1 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary focus:outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-tertiary uppercase tracking-wide">Channel</label>
                <div className="flex mt-1 rounded-md border border-border-default overflow-hidden text-sm">
                  <button
                    onClick={() => setChannel('FBA')}
                    className={`flex-1 h-9 transition-colors ${channel === 'FBA' ? 'bg-accent/15 text-accent font-medium' : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'}`}
                  >
                    FBA
                  </button>
                  <button
                    onClick={() => setChannel('MFN')}
                    className={`flex-1 h-9 border-l border-border-default transition-colors ${channel === 'MFN' ? 'bg-accent/15 text-accent font-medium' : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'}`}
                  >
                    Merchant Fulfilled
                  </button>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setShowNew(false)}
                className="h-9 px-3 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || creating}
                className="h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {creating ? 'Creating…' : 'Create & Start'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
