// Types shared by the server and the web UI (the web imports this file directly).

export const FIELD_TYPES = ["text", "longtext", "number", "money", "date", "boolean", "select", "ref"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldOptions {
  /** select: allowed values */
  choices?: string[];
  /** money: ISO currency code shown next to the amount */
  currency?: string;
  /** ref: if set, the target object must carry this component key */
  component?: string;
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  description: string;
  required: boolean;
  options: FieldOptions;
  position: number;
}

export interface ComponentDef {
  id: string;
  key: string;
  name: string;
  description: string;
  aiHint: string;
  color: string;
  fields: FieldDef[];
  usage?: number;
}

/** Input shape for creating/updating a component definition. Fields with an id are updated in place. */
export interface ComponentInput {
  key: string;
  name: string;
  description: string;
  aiHint: string;
  color?: string;
  fields: Array<Omit<FieldDef, "id" | "position"> & { id?: string }>;
}

/**
 * A field value inside a draft.
 * - number / money: number
 * - boolean: boolean
 * - date: "YYYY-MM-DD"
 * - ref: an existing entity id, or "new:<tempId>" pointing at an object in `Draft.newObjects`
 * - everything else: string
 */
export type DraftValue = string | number | boolean | null;

export interface DraftComponent {
  /** component key; may name an entry in `Draft.newComponents` */
  component: string;
  /** field key -> value */
  values: Record<string, DraftValue>;
}

export interface DraftNewObject {
  tempId: string;
  title: string;
  components: DraftComponent[];
}

/**
 * The editable description of an entity's metadata. The AI produces one as its
 * proposal; the UI edits it; applying it writes everything in one transaction.
 */
export interface Draft {
  title: string;
  documentDate: string | null;
  components: DraftComponent[];
  /** Component definitions to create when the draft is applied. */
  newComponents: ComponentInput[];
  /** Objects (cars, houses, ...) to create when the draft is applied. */
  newObjects: DraftNewObject[];
}

export interface Proposal {
  draft: Draft;
  reasoning: string;
  model: string;
  createdAt: string;
  /** Issues found while validating the model's output (dropped values etc.). */
  warnings: string[];
}

export type DocumentStatus = "queued" | "ocr" | "analyzing" | "inbox" | "filed" | "failed";

export interface DocumentSummary {
  id: string;
  title: string;
  status: DocumentStatus;
  originalFilename: string;
  mimeType: string;
  documentDate: string | null;
  addedAt: string;
  pageCount: number | null;
  hasThumb: boolean;
  components: string[];
  snippet?: string;
  error: string | null;
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  fileSize: number;
  hasArchive: boolean;
  current: Draft;
  proposal: Proposal | null;
}

export interface ObjectSummary {
  id: string;
  title: string;
  notes: string;
  components: string[];
  /** short "Vehicle: Honda Civic 2019" style description for pickers and the AI */
  summary: string;
  documentCount: number;
}

export interface ObjectDetail extends ObjectSummary {
  current: Draft;
}
