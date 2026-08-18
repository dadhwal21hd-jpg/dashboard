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
      "FRONTIER RAAS [P] LTD.",
      "GNE Exports Pvt. Ltd.",
      "GNE (Nittu Di)",
      "GNE (Tushar Ji)",
      "FR Tushar ji",
    ],
  },
  {
    name: "Seasons Group",
    members: [
      "Seasons Enterprises Pvt. Ltd.",
      "SEASONS ENTERPRISES PVT LTD",
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
    name: "Ganpati Group",
    members: ["Ganpati Textiles", "GANPATI TEXTILES.", "Ganpati Shop"],
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
    members: ["KOMAL MAM", "KRITI MAM", "KRITI MAM(SUMINA SOOD)", "BITTU SIR", "NITTU SIR", "KIRTI MAM HOUSE"],
  },
  {
    name: "BHOPAL GROUP",
    // "TANIA DI (BHOPAL )" (trailing space before the bracket) is how the
    // new data source spells it — kept as a separate entry since it isn't
    // caught by the case-insensitive match against "TANIA DI (BHOPAL)".
    members: ["ABHI BHOPAL", "TANIA DI (BHOPAL)", "TANIA DI (BHOPAL )", "Tania di"],
  },
  {
    name: "Triage Industries Group",
    members: [
      "TRAIGE INDUSTRIES",
      "Triage Industries",
      "Traige Industries",
      "Triage Indsutries",
      "TRIAGE INDUSTRIES PVT LTD",
    ],
  },
  {
    name: "Chinto Ji Group",
    members: ["CHINTO JI", "Chintu Ji (Chandni Chowk)", "SHABAD RAJOORI", "SHABAD RAJOURI"],
  },
  {
    name: "Roop Kala Group",
    members: ["Roop Kala", "ROOP KALA"],
  },
  {
    name: "Ria Boutique Group",
    members: ["Ria Boutique", "RIYA BOUTIQUE"],
  },
  {
    name: "Dimple Fashion Group",
    members: ["Dimple Fashion", "DIMPLE FASHION"],
  },
  {
    name: "Kala Shree Heritage Group",
    members: ["Kala Shree Heritage", "KALA SHREE HERITAGE"],
  },
  {
    name: "Gullu Exclusive Group",
    members: ["Gullu Exclusive", "GULLU EXCLUSIVE INTERNATIONAL"],
  },
  {
    name: "Sham Fashion Group",
    members: ["SHAM FASHION", "SHAM FASHION MALL"],
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
