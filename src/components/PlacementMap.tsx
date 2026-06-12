'use client';

import { useMemo } from 'react';
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
  Line,
} from 'react-simple-maps';

// Vendored from https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json so the
// map renders without a runtime CDN dependency (offline / blocked-CDN safe).
const GEO_URL = '/maps/us-states-10m.json';

// Option colors: each placement option gets its own color for its routes/dots
const OPTION_COLORS = ['#7CFF3A', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6'];

export interface MapShipmentMeta {
  shipmentId: string;
  fcCode: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  distanceMiles: number | null;
}

interface PlacementMapOption {
  placementOptionId: string;
  shipmentIds: string[];
}

interface PlacementMapProps {
  options: PlacementMapOption[];
  shipmentMeta: Record<string, MapShipmentMeta>;
  shipFromLat: number | null;
  shipFromLng: number | null;
  hoveredOptionId?: string | null;
  confirmedOptionId?: string | null;
  height?: number;
}

export default function PlacementMap({
  options,
  shipmentMeta,
  shipFromLat,
  shipFromLng,
  hoveredOptionId,
  confirmedOptionId,
  height = 400,
}: PlacementMapProps) {
  const hasShipFrom = shipFromLat != null && shipFromLng != null;

  // Active option = hovered first, then confirmed, then first option
  const activeOptionId = hoveredOptionId ?? confirmedOptionId ?? options[0]?.placementOptionId ?? null;

  const lines = useMemo(() => {
    if (!hasShipFrom) return [];
    return options.flatMap((opt, idx) => {
      const color = OPTION_COLORS[idx % OPTION_COLORS.length];
      const isActive = opt.placementOptionId === activeOptionId;
      return opt.shipmentIds
        .map((sid) => {
          const meta = shipmentMeta[sid];
          if (!meta?.lat || !meta?.lng) return null;
          return {
            from: [shipFromLng!, shipFromLat!] as [number, number],
            to: [meta.lng, meta.lat] as [number, number],
            color,
            isActive,
          };
        })
        .filter(Boolean) as {
          from: [number, number];
          to: [number, number];
          color: string;
          isActive: boolean;
        }[];
    });
  }, [options, shipmentMeta, shipFromLat, shipFromLng, activeOptionId, hasShipFrom]);

  const activeShipmentIds = useMemo(
    () => options.find((o) => o.placementOptionId === activeOptionId)?.shipmentIds ?? [],
    [options, activeOptionId]
  );

  return (
    <div
      className="relative w-full bg-[#0a0d12] rounded-lg overflow-hidden border border-[#1f2937]"
      style={{ height }}
    >
      <ComposableMap
        projection="geoAlbersUsa"
        style={{ width: '100%', height: '100%' }}
      >
        {/* State geography — dark night-map feel */}
        <Geographies geography={GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo) => (
              <Geography
                key={geo.rsmKey}
                geography={geo}
                fill="#111827"
                stroke="#1f2937"
                strokeWidth={0.6}
                tabIndex={-1}
                style={{
                  default: { outline: 'none' },
                  hover: { outline: 'none' },
                  pressed: { outline: 'none' },
                }}
              />
            ))
          }
        </Geographies>

        {/* Inactive routes — drawn first, behind active */}
        {lines.filter((l) => !l.isActive).map((l, i) => (
          <Line
            key={`inactive-${i}`}
            from={l.from}
            to={l.to}
            stroke={l.color}
            strokeWidth={1}
            strokeOpacity={0.12}
            strokeDasharray="6 4"
          />
        ))}

        {/* Active routes — dashed, bright */}
        {lines.filter((l) => l.isActive).map((l, i) => (
          <Line
            key={`active-${i}`}
            from={l.from}
            to={l.to}
            stroke={l.color}
            strokeWidth={1.5}
            strokeOpacity={0.8}
            strokeDasharray="6 4"
          />
        ))}

        {/* Destination FC dots */}
        {Object.values(shipmentMeta).map((meta) => {
          if (!meta.lat || !meta.lng) return null;
          const optIdx = options.findIndex((o) => o.shipmentIds.includes(meta.shipmentId));
          const color = OPTION_COLORS[optIdx % OPTION_COLORS.length] ?? '#6b7280';
          const isActive = activeShipmentIds.includes(meta.shipmentId);
          return (
            <Marker key={meta.shipmentId} coordinates={[meta.lng, meta.lat]}>
              <circle
                r={isActive ? 5 : 3}
                fill={color}
                fillOpacity={isActive ? 1 : 0.3}
                stroke={isActive ? '#000' : '#0a0d12'}
                strokeWidth={isActive ? 0.8 : 0.5}
              />
              {isActive && meta.fcCode && (
                <text
                  textAnchor="middle"
                  y={-9}
                  style={{
                    fontSize: 8,
                    fill: color,
                    fontWeight: 700,
                    fontFamily: 'monospace',
                    pointerEvents: 'none',
                    letterSpacing: '0.04em',
                  }}
                >
                  {meta.fcCode}
                </text>
              )}
            </Marker>
          );
        })}

        {/* Ship-from marker — white dot with "YOU" label */}
        {hasShipFrom && (
          <Marker coordinates={[shipFromLng!, shipFromLat!]}>
            <circle r={7} fill="#ffffff" stroke="#000000" strokeWidth={1.5} />
            <circle r={3} fill="#000000" />
            <text
              textAnchor="middle"
              y={-12}
              style={{
                fontSize: 8,
                fill: '#ffffff',
                fontWeight: 700,
                fontFamily: 'sans-serif',
                pointerEvents: 'none',
                letterSpacing: '0.06em',
              }}
            >
              YOU
            </text>
          </Marker>
        )}
      </ComposableMap>
    </div>
  );
}
