// The About form of the source page (§4.6) sends only the fields that the
// person changed, so that a save never reverts a field that another person
// changed in the meantime. Pure: the form and the tests import it.

export interface AboutValues {
  name: string;
  why: string;
  owner: string;
  /** The check interval in minutes, as the select gives it. */
  interval: string;
}

export interface AboutPatch {
  name?: string;
  why?: string;
  owner?: string | null;
  checkIntervalMinutes?: number;
}

/** The fields of `values` that differ from `base` (the values that the form saw). An empty owner is null. */
export function aboutPatch(base: AboutValues, values: AboutValues): AboutPatch {
  const patch: AboutPatch = {};
  if (values.name.trim() !== base.name.trim()) patch.name = values.name;
  if (values.why.trim() !== base.why.trim()) patch.why = values.why;
  if (values.owner.trim() !== base.owner.trim()) patch.owner = values.owner.trim() ? values.owner : null;
  if (Number(values.interval) !== Number(base.interval)) patch.checkIntervalMinutes = Number(values.interval);
  return patch;
}
