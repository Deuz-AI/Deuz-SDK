/**
 * The headless doctor's report (2.3 preview, 23.8): why a provider / model /
 * configuration will not work, found before any call. Pure and edge-safe.
 */
import type { ModelProfile } from '../model-profile';
import type { ModelSurface } from '../types/model';

/** How serious a finding is: an `error` means the run will not work as configured. */
export type DoctorSeverity = 'error' | 'warning' | 'info';

/** One thing the doctor found (2.3 preview). `code` is stable; `message` is for people. */
export interface DoctorFinding {
  severity: DoctorSeverity;
  code: string;
  message: string;
  /** The option it concerns, when there is one. */
  setting?: string;
}

/** A provider / model / configuration report (2.3 preview). Plain JSON. */
export interface DoctorReport {
  kind: 'deuz-headless-doctor';
  version: 1;
  /** No finding is an error. */
  ok: boolean;
  findings: DoctorFinding[];
}

export type { ModelProfile, ModelSurface };
