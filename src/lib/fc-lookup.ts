/**
 * Lookup table of common Amazon FC (Fulfillment Center) codes → geographic info.
 * Used to enrich placement option data with city/state/lat/lng so the UI can
 * display a map and compute distances.
 *
 * Sources: Amazon known FC list, public FC directories.
 * Coordinates are accurate to ~0.01° (good enough for distance calculations).
 */

export const FC_LOOKUP: Record<string, { city: string; state: string; lat: number; lng: number }> = {
  // ── Pennsylvania ──────────────────────────────────────────────────────────
  ABE2: { city: 'Bethlehem',      state: 'PA', lat: 40.62, lng: -75.37 },
  ABE3: { city: 'Hazle Township', state: 'PA', lat: 40.96, lng: -75.99 },
  ABE8: { city: 'Whitehall',      state: 'PA', lat: 40.65, lng: -75.49 },
  PHL7: { city: 'Carlisle',       state: 'PA', lat: 40.19, lng: -77.19 },
  PHL4: { city: 'Philadelphia',   state: 'PA', lat: 39.97, lng: -75.17 },

  // ── New Jersey ────────────────────────────────────────────────────────────
  EWR4: { city: 'Robbinsville',   state: 'NJ', lat: 40.21, lng: -74.61 },
  EWR9: { city: 'Carteret',       state: 'NJ', lat: 40.58, lng: -74.22 },
  EWR6: { city: 'Avenel',         state: 'NJ', lat: 40.58, lng: -74.28 },

  // ── New York ──────────────────────────────────────────────────────────────
  JFK8: { city: 'Staten Island',  state: 'NY', lat: 40.62, lng: -74.15 },
  ALB1: { city: 'Schodack',       state: 'NY', lat: 42.49, lng: -73.67 },

  // ── Maryland / Virginia ───────────────────────────────────────────────────
  BWI2: { city: 'Baltimore',      state: 'MD', lat: 39.17, lng: -76.67 },
  DCA1: { city: 'Sterling',       state: 'VA', lat: 39.00, lng: -77.45 },
  RIC1: { city: 'Chester',        state: 'VA', lat: 37.36, lng: -77.43 },
  RIC2: { city: 'Chester',        state: 'VA', lat: 37.38, lng: -77.43 },

  // ── North Carolina ────────────────────────────────────────────────────────
  GSO1: { city: 'Kernersville',   state: 'NC', lat: 36.12, lng: -80.08 },
  CLT2: { city: 'Charlotte',      state: 'NC', lat: 35.32, lng: -80.90 },
  RDU1: { city: 'Garner',         state: 'NC', lat: 35.69, lng: -78.59 },

  // ── Georgia / Florida ─────────────────────────────────────────────────────
  ATL6: { city: 'Lithia Springs', state: 'GA', lat: 33.79, lng: -84.66 },
  RYY2: { city: 'White',          state: 'GA', lat: 34.28, lng: -84.75 },
  ATL7: { city: 'Atlanta',        state: 'GA', lat: 33.64, lng: -84.44 },
  JAX2: { city: 'Jacksonville',   state: 'FL', lat: 30.28, lng: -81.56 },
  JAX3: { city: 'Jacksonville',   state: 'FL', lat: 30.33, lng: -81.66 },
  MCO1: { city: 'Kissimmee',      state: 'FL', lat: 28.20, lng: -81.60 },
  TPA1: { city: 'Ruskin',         state: 'FL', lat: 27.73, lng: -82.39 },
  MIA1: { city: 'Opa-locka',      state: 'FL', lat: 25.91, lng: -80.28 },

  // ── Alabama ───────────────────────────────────────────────────────────────
  HSV1: { city: 'Madison',        state: 'AL', lat: 34.70, lng: -86.74 },

  // ── Tennessee ─────────────────────────────────────────────────────────────
  BNA1: { city: 'Murfreesboro',   state: 'TN', lat: 35.85, lng: -86.43 },
  BNA2: { city: 'Lebanon',        state: 'TN', lat: 36.22, lng: -86.29 },
  MEM1: { city: 'Memphis',        state: 'TN', lat: 35.04, lng: -90.00 },

  // ── Ohio ──────────────────────────────────────────────────────────────────
  CMH1: { city: 'Etna',           state: 'OH', lat: 39.96, lng: -82.68 },
  CMH2: { city: 'Groveport',      state: 'OH', lat: 39.88, lng: -82.89 },
  CMH3: { city: 'Heath',          state: 'OH', lat: 40.03, lng: -82.48 },
  CMH4: { city: 'Obetz',          state: 'OH', lat: 39.87, lng: -82.96 },
  CVG1: { city: 'Erlanger',       state: 'KY', lat: 39.03, lng: -84.59 },
  CVG2: { city: 'Walton',         state: 'KY', lat: 38.89, lng: -84.63 },
  CVG3: { city: 'Hebron',         state: 'KY', lat: 39.06, lng: -84.74 },

  // ── Indiana ───────────────────────────────────────────────────────────────
  FWA4: { city: 'Fort Wayne',     state: 'IN', lat: 41.08, lng: -85.14 },
  IND1: { city: 'Plainfield',     state: 'IN', lat: 39.69, lng: -86.39 },
  IND2: { city: 'Whitestown',     state: 'IN', lat: 39.99, lng: -86.37 },
  IND5: { city: 'Jeffersonville', state: 'IN', lat: 38.30, lng: -85.72 },

  // ── Michigan ──────────────────────────────────────────────────────────────
  DTW1: { city: 'Romulus',        state: 'MI', lat: 42.20, lng: -83.36 },

  // ── Illinois ──────────────────────────────────────────────────────────────
  MDW2: { city: 'Joliet',         state: 'IL', lat: 41.44, lng: -88.11 },
  MDW6: { city: 'Monee',          state: 'IL', lat: 41.41, lng: -87.74 },
  ORD2: { city: 'Channahon',      state: 'IL', lat: 41.43, lng: -88.21 },
  ORD9: { city: 'Markham',        state: 'IL', lat: 41.59, lng: -87.68 },

  // ── Minnesota ─────────────────────────────────────────────────────────────
  MSP1: { city: 'Shakopee',       state: 'MN', lat: 44.81, lng: -93.46 },

  // ── Missouri ──────────────────────────────────────────────────────────────
  STL7: { city: 'Edwardsville',   state: 'IL', lat: 38.81, lng: -89.98 },

  // ── Kansas / Nebraska ─────────────────────────────────────────────────────
  ICT1: { city: 'Derby',          state: 'KS', lat: 37.55, lng: -97.27 },
  OMA1: { city: 'La Vista',       state: 'NE', lat: 41.18, lng: -96.03 },

  // ── Texas ─────────────────────────────────────────────────────────────────
  DAL1: { city: 'Coppell',        state: 'TX', lat: 32.95, lng: -97.02 },
  DAL3: { city: 'Forney',         state: 'TX', lat: 32.76, lng: -96.47 },
  DFW7: { city: 'Haslet',         state: 'TX', lat: 32.97, lng: -97.33 },
  HOU1: { city: 'Katy',           state: 'TX', lat: 29.79, lng: -95.83 },
  HOU2: { city: 'Houston',        state: 'TX', lat: 29.72, lng: -95.55 },
  SAT1: { city: 'San Antonio',    state: 'TX', lat: 29.42, lng: -98.46 },
  AUS1: { city: 'Kyle',           state: 'TX', lat: 29.99, lng: -97.88 },

  // ── Colorado ──────────────────────────────────────────────────────────────
  DEN2: { city: 'Aurora',         state: 'CO', lat: 39.71, lng: -104.76 },
  DEN7: { city: 'Thornton',       state: 'CO', lat: 39.90, lng: -104.93 },

  // ── Nevada ────────────────────────────────────────────────────────────────
  LAS1: { city: 'North Las Vegas', state: 'NV', lat: 36.28, lng: -115.08 },
  LAS2: { city: 'Henderson',      state: 'NV', lat: 36.00, lng: -115.07 },

  // ── Arizona ───────────────────────────────────────────────────────────────
  GEU3: { city: 'Goodyear',       state: 'AZ', lat: 33.40, lng: -112.39 },
  GYR1: { city: 'Goodyear',       state: 'AZ', lat: 33.44, lng: -112.36 },
  GYR2: { city: 'Goodyear',       state: 'AZ', lat: 33.43, lng: -112.36 },
  PHX3: { city: 'Goodyear',       state: 'AZ', lat: 33.45, lng: -112.38 },
  PHX7: { city: 'Mesa',           state: 'AZ', lat: 33.37, lng: -111.79 },

  // ── California ────────────────────────────────────────────────────────────
  LAX9: { city: 'Redlands',       state: 'CA', lat: 34.06, lng: -117.12 },
  ONT2: { city: 'San Bernardino', state: 'CA', lat: 34.08, lng: -117.27 },
  ONT6: { city: 'Moreno Valley',  state: 'CA', lat: 33.93, lng: -117.27 },
  ONT8: { city: 'Rialto',         state: 'CA', lat: 34.09, lng: -117.37 },
  SBD1: { city: 'Fontana',        state: 'CA', lat: 34.11, lng: -117.50 },
  SCK8: { city: 'Oakley',         state: 'CA', lat: 37.99, lng: -121.71 },
  TCY2: { city: 'Stockton',       state: 'CA', lat: 37.97, lng: -121.31 },
  SMF1: { city: 'Sacramento',     state: 'CA', lat: 38.59, lng: -121.49 },
  SFO1: { city: 'Tracy',          state: 'CA', lat: 37.74, lng: -121.44 },
  SJC7: { city: 'Tracy',          state: 'CA', lat: 37.77, lng: -121.40 },
  LAX7: { city: 'San Bernardino', state: 'CA', lat: 34.04, lng: -117.20 },

  // ── Oregon ────────────────────────────────────────────────────────────────
  PDX9: { city: 'Troutdale',      state: 'OR', lat: 45.54, lng: -122.39 },

  // ── Washington ────────────────────────────────────────────────────────────
  SEA6: { city: 'Seattle',        state: 'WA', lat: 47.54, lng: -122.30 },
  SEA8: { city: 'Seattle',        state: 'WA', lat: 47.53, lng: -122.25 },
  GEG1: { city: 'Spokane Valley', state: 'WA', lat: 47.69, lng: -117.21 },

  // ── Massachusetts ────────────────────────────────────────────────────────
  BOS7: { city: 'Stoughton',      state: 'MA', lat: 42.12, lng: -71.09 },

  // ── Connecticut ───────────────────────────────────────────────────────────
  BDL1: { city: 'Windsor',        state: 'CT', lat: 41.87, lng: -72.64 },

  // ── Delaware ──────────────────────────────────────────────────────────────
  PHL1: { city: 'New Castle',     state: 'DE', lat: 39.67, lng: -75.59 },
};

export function lookupFC(
  code: string
): { city: string; state: string; lat: number; lng: number } | null {
  if (!code) return null;
  return FC_LOOKUP[code.toUpperCase()] ?? null;
}
