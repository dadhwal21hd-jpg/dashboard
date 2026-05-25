/**
 * Customer cluster definitions.
 *
 * Maps a cluster display name to its member customer names (as they appear
 * in the Google Sheet). Member matching is case-insensitive and trims
 * whitespace, so casing differences in the Sheet don't break grouping.
 *
 * Customers not listed in any cluster appear standalone in the Clustered view.
 *
 * To edit: change this file, commit, push. Vercel redeploys in ~2 min.
 */

export interface ClusterDef {
  name: string;        // Display name shown in the dashboard
  members: string[];   // Exact (or case-insensitive) names from the Sheet
}

export const CLUSTERS: ClusterDef[] = [
  {
    name: "Frontier Raas Group",
    members: [
      "FRONTIER RAAS (P) LTD",
      "GNE Exports Pvt. Ltd.",
      "GNE (Nittu Di)",
      "GNE (Tushar Ji)",
    ],
  },
  {
    name: "Seasons Group",
    members: [
      "Seasons Enterprises Pvt. Ltd.",
      "Season Bharat",
      "Season Amin",
      "Season AMIN",
      "Season Santosh",
      "Season LC",
      "Season Dipesh",
      "Season Hiten",
      "Season Sunil",
    ],
  },
  {
    name: "Shakuntlam Group",
    members: ["SHAKUNTLAM (RAJOURI)", "SHAKUNTLAM (Lajpat Nagar)"],
  },
  {
    name: "Ganpati Group",
    members: ["Ganpati Textiles", "Ganpati Shop"],
  },
  {
    name: "Sachdeva Group",
    members: ["SACHDEVA SAREES", "SACHDEVA BARELY"],
  },
  {
    name: "Bhupinder Singh Group",
    members: ["Bhupinder Singh & Sons II", "Bhupinder Singh"],
  },
  {
    name: "Rana Group",
    members: ["RANA SAHAB", "RANA JI"],
  },
  {
    name: "Dhanlakshmi Group",
    members: ["DHANLAKSHMI", "SRI DHAN LAKSHMI"],
  },
  {
    name: "Cash Sales",
    members: ["CASH (SHOP )", "CASH"],
  },
  {
    name: "Family",
    members: ["KOMAL MAM", "KRITI MAM", "BITTU SIR", "NITTU SIR"],
  },
];

/** Normalise a name for comparison (lowercase + trim, collapse multiple spaces). */
function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a lookup: customer name (as-found-in-sheet) → cluster name.
 * Returns undefined for customers not in any cluster.
 */
export function buildClusterLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const cluster of CLUSTERS) {
    for (const member of cluster.members) {
      lookup.set(normalise(member), cluster.name);
    }
  }
  return lookup;
}

/** Look up which cluster a given customer name belongs to. */
export function clusterFor(customerName: string, lookup: Map<string, string>): string | undefined {
  return lookup.get(normalise(customerName));
}
