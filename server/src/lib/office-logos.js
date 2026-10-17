// Office logos from the Citizen's Charter set ("Malaybalay Office Logos", Office-to-image mapping.csv), keyed by
// offices.short_name. Files live in public/img/office-logos/. An office missing here has no logo of its own:
// the database records has_logo = 0 and the kiosk shows the shared city seal (CITY_SEAL) in its place.
// Offices whose Charter section shows only the city seal (CMO, BPLD, OSCA, OBO, CSWDO, CHO) and offices not in
// the Charter (MIS, PMES) are deliberately absent.
export const CITY_SEAL = '/img/office-logos/city-seal.png';

export const OFFICE_LOGOS = {
  BAC: 'bids-and-awards-committee.png',
  CAcO: 'city-accounting-office.png',
  CAdO: 'city-administrators-office.png',
  CAgO: 'city-agriculture-office.png',
  CASSO: 'city-assessors-office.png',
  CBO: 'city-budget-office.png',
  CCRO: 'city-civil-registry-office.png',
  CDRRMO: 'city-disaster-risk-reduction-and-management-office.png',
  CEEDMO: 'city-economic-enterprise-development-and-management-office.png',
  CEO: 'city-engineers-office.png',
  CENRO: 'city-environment-and-natural-resources-office.png',
  CGSO: 'city-general-services-office.png',
  CHRMO: 'city-human-resources-management-office.png',
  CLO: 'city-legal-office.png',
  CPDO: 'city-planning-and-development-office.png',
  CTO: 'city-treasurers-office.png',
  CUDHD: 'city-urban-development-and-housing-division.png',
  CVO: 'city-veterinary-office.png',
  CVMO: 'city-vice-mayors-office.png', // Sangguniang Panlungsod seal, as the Charter uses for this office
  PESO: 'public-employment-service-office.png',
};

export const logoUrl = file => (file ? `/img/office-logos/${file}` : null);

/** SQL that records each mapped office's logo (offices not in the map keep has_logo = 0, logo_file NULL). */
export function officeLogoUpdatesSQL() {
  const q = s => `'${s.replace(/'/g, "''")}'`;
  return Object.entries(OFFICE_LOGOS)
    .map(([short, file]) => `UPDATE offices SET has_logo = 1, logo_file = ${q(file)} WHERE short_name = ${q(short)};`)
    .join('\n');
}
