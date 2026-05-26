export * from './structural-diff';
export * from './severity';
// R-154: deliverable-id-based diff and severity classifier. Lives next to
// the text-hash structural diff so consumers can pick the model that suits
// their data (legacy plan content arrays vs split-table PlanDeliverable
// rows). drift-engine prefers this one when running on R-150/R-153 data.
export * from './deliverable-diff';
