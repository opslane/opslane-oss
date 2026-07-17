export function shouldSwitchOrg(selectedOrgID: string, activeOrgID: string, switching: boolean): boolean {
  return !!selectedOrgID && selectedOrgID !== activeOrgID && !switching;
}
