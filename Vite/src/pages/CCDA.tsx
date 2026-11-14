import React, { useState, useMemo, useCallback, useEffect } from 'react';

import Parse from "parse";
import { PARSE_APP_ID, PARSE_JS_KEY, PARSE_SERVER_URL } from "../api";
import NavigationBar from "../components/NavigationBar";

// ==========================================
// SVG ICON COMPONENTS (Raw SVGs, Self-Contained)
// ==========================================

interface IconProps {
  className?: string;
}

const IconUser = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
  </svg>
);

const IconPill = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="7" y="2" width="10" height="20" rx="5" transform="rotate(45 12 12)" />
    <line x1="7" y1="12" x2="17" y2="12" transform="rotate(45 12 12)" />
  </svg>
);

const IconAlertTriangle = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

const IconSyringe = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 21l4-4" />
    <path d="M5.5 15.5l8-8 3 3-8 8z" />
    <path d="M12.5 6.5l5 5" />
    <path d="M15 9l4.5-4.5" />
    <path d="M18 3l3 3" />
    <path d="M8.5 12.5l2 2" />
    <path d="M10.5 10.5l2 2" />
  </svg>
);

const IconActivity = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
);

const IconScissors = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 0A3 3 0 104.879 4.879a3 3 0 004.242 4.242zm0 5.758a3 3 0 10-4.242 4.242 3 3 0 004.242-4.242z" />
  </svg>
);

const IconUsers = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
);

const IconCopy = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const IconDownload = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

const IconCheck = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

const IconChevronRight = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
  </svg>
);

const IconChevronDown = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

const IconCode = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
  </svg>
);

const IconLayoutDashboard = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
);

const IconSearch = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);

const IconFileCode = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const IconSparkles = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
  </svg>
);

const IconFileUp = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const IconCheckCircle = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const IconAlertCircle = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const IconMapPin = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const IconPhone = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
  </svg>
);

const IconCalendar = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const IconCloud = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 00-.1-9.999 5.002 5.002 0 00-9.78 2.096A4.001 4.001 0 003 15z" />
  </svg>
);

const IconUploadCloud = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
  </svg>
);

const IconRefreshCw = ({ className = "w-4 h-4" }: IconProps) => (
  <svg className={className} width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

// ==========================================
// TYPE DEFINITIONS FOR PARSE API OBJECT
// ==========================================

export interface Patient {
  name: string;
  birth_date: string;
  gender: string;
  marital_status: string;
  address: string;
  telephone: string;
}

export interface Medication {
  name: string;
  code: string;
  status: string;
  sig: string;
  date: string;
}

export interface Problem {
  name: string;
  code: string;
  status: string;
  onset_date: string;
}

export interface Allergy {
  substance: string;
  reaction: string;
  severity: string;
  status: string;
}

export interface Immunization {
  vaccine: string;
  date: string;
  status: string;
}

export interface Vital {
  name: string;
  value: string;
  unit: string;
  date: string;
}

export interface Procedure {
  name: string;
  date: string;
  status: string;
}

export interface SocialHistoryItem {
  category: string;
  observation: string;
  date: string;
}

export interface ParseApiObject {
  patient: Patient;
  medications: Medication[];
  problems: Problem[];
  allergies: Allergy[];
  immunizations: Immunization[];
  vitals: Vital[];
  procedures: Procedure[];
  social_history: SocialHistoryItem[];
}

export interface ParsedResult {
  parseApiObject: ParseApiObject;
  durationMs: string;
  error?: string;
}

export interface ToastNotification {
  msg: string;
  type: 'success' | 'error' | 'info';
}

const PARSE_CLASS_NAME = 'ccda_object';

export interface SavedParseRecord {
  objectId: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  patientName: string;
  patientDob: string;
  parseApiObject: ParseApiObject;
}

export interface JsonNodeProps {
  name?: string;
  value: unknown;
  isLast?: boolean;
}

// Helper to render primitive strings safely without throwing JSX object-child errors
function renderString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.displayName === 'string') return obj.displayName;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.value === 'string') return obj.value;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.message === 'string') return obj.message;
    try {
      return JSON.stringify(val);
    } catch {
      return '[Object]';
    }
  }
  return String(val);
}

function isReactElementOrInternal(val: unknown): boolean {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    React.isValidElement(val) ||
    '$$typeof' in obj ||
    '_owner' in obj ||
    '_store' in obj ||
    ('type' in obj && 'props' in obj)
  );
}

// ==========================================
// XML HELPER UTILITIES
// ==========================================

function getElements(parent: Element | Document | null, tagName: string): Element[] {
  if (!parent) return [];
  const list: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element;
    const local = el.localName || el.nodeName.replace(/^.*:/, '');
    if (local.toLowerCase() === tagName.toLowerCase()) {
      list.push(el);
    }
  }
  return list;
}

function getFirstElement(parent: Element | Document | null, tagName: string): Element | null {
  const list = getElements(parent, tagName);
  return list.length > 0 ? list[0] : null;
}

function getAttr(el: Element | null, attrName: string): string {
  if (!el || !el.getAttribute) return '';
  return el.getAttribute(attrName) || '';
}

function parseHL7Date(str: string | null | undefined): string {
  if (!str) return 'N/A';
  const clean = str.trim();
  if (clean.length >= 8) {
    const y = clean.substring(0, 4);
    const m = clean.substring(4, 6);
    const d = clean.substring(6, 8);
    return `${y}-${m}-${d}`;
  }
  if (clean.length >= 4) return clean.substring(0, 4);
  return clean;
}

function mapGender(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const c = code.toUpperCase();
  if (c === 'F' || c === 'FEMALE') return 'Female';
  if (c === 'M' || c === 'MALE') return 'Male';
  if (c === 'UN') return 'Undisclosed';
  return code;
}

function mapMarital(code: string | null | undefined): string {
  if (!code) return 'Single';
  const c = code.toUpperCase();
  const map: Record<string, string> = { M: 'Married', S: 'Single', D: 'Divorced', W: 'Widowed', L: 'Legally Separated', U: 'Unmarried' };
  return map[c] || code;
}

function findSection(xmlDoc: Document, templatePatterns: string[], keywords: string[]): Element | null {
  const sections = getElements(xmlDoc, 'section');
  for (const sec of sections) {
    const templates = getElements(sec, 'templateId');
    for (const t of templates) {
      const root = getAttr(t, 'root');
      for (const p of templatePatterns) {
        if (root.includes(p)) return sec;
      }
    }
    const codeEl = getFirstElement(sec, 'code');
    if (codeEl) {
      const disp = getAttr(codeEl, 'displayName').toLowerCase();
      for (const kw of keywords) {
        if (disp.includes(kw.toLowerCase())) return sec;
      }
    }
    const titleEl = getFirstElement(sec, 'title');
    if (titleEl && titleEl.textContent) {
      const titleText = titleEl.textContent.toLowerCase();
      for (const kw of keywords) {
        if (titleText.includes(kw.toLowerCase())) return sec;
      }
    }
  }
  return null;
}

// ==========================================
// C-CDA XML PARSER ENGINE
// ==========================================

function parseCCDA(xmlString: string): ParsedResult {
  const startTime = performance.now();
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

  const parseErrors = xmlDoc.getElementsByTagName('parsererror');
  if (parseErrors.length > 0) {
    throw new Error('Malformed XML document: ' + (parseErrors[0].textContent || 'Unknown error'));
  }

  // Demographics
  const patientRole = getFirstElement(xmlDoc, 'patientRole');
  const patientData: Patient = {
    name: 'Unknown Patient',
    birth_date: 'N/A',
    gender: 'Unknown',
    marital_status: 'Unknown',
    address: 'N/A',
    telephone: 'N/A'
  };

  if (patientRole) {
    const ptEl = getFirstElement(patientRole, 'patient');
    if (ptEl) {
      const nameEl = getFirstElement(ptEl, 'name');
      if (nameEl) {
        const givens = getElements(nameEl, 'given').map(e => (e.textContent || '').trim()).filter(Boolean);
        const family = (getFirstElement(nameEl, 'family')?.textContent || '').trim();
        patientData.name = [...givens, family].join(' ').trim() || 'Unknown Patient';
      }

      const birthEl = getFirstElement(ptEl, 'birthTime');
      patientData.birth_date = birthEl ? parseHL7Date(getAttr(birthEl, 'value')) : 'N/A';

      const genderEl = getFirstElement(ptEl, 'administrativeGenderCode');
      patientData.gender = genderEl ? (getAttr(genderEl, 'displayName') || mapGender(getAttr(genderEl, 'code'))) : 'Unknown';

      const maritalEl = getFirstElement(ptEl, 'maritalStatusCode');
      patientData.marital_status = maritalEl ? (getAttr(maritalEl, 'displayName') || mapMarital(getAttr(maritalEl, 'code'))) : 'Single';
    }

    const addrEl = getFirstElement(patientRole, 'addr');
    if (addrEl) {
      const streets = getElements(addrEl, 'streetAddressLine').map(e => (e.textContent || '').trim()).filter(Boolean);
      const city = (getFirstElement(addrEl, 'city')?.textContent || '').trim();
      const state = (getFirstElement(addrEl, 'state')?.textContent || '').trim();
      const postal = (getFirstElement(addrEl, 'postalCode')?.textContent || '').trim();
      const country = (getFirstElement(addrEl, 'country')?.textContent || '').trim();
      patientData.address = [streets.join(', '), city, state, postal, country].filter(Boolean).join(', ');
    }

    const teleEl = getFirstElement(patientRole, 'telecom');
    if (teleEl) {
      let val = getAttr(teleEl, 'value') || (teleEl.textContent || '').trim();
      if (val.startsWith('tel:')) val = val.substring(4);
      patientData.telephone = val || 'N/A';
    }
  }

  // Medications
  const medications: Medication[] = [];
  const medSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.1.1', '2.16.840.1.113883.10.20.22.2.1'], ['medication']);
  if (medSection) {
    const entries = getElements(medSection, 'substanceAdministration');
    entries.forEach(entry => {
      const consumable = getFirstElement(entry, 'consumable');
      const manufacturedProduct = consumable ? getFirstElement(consumable, 'manufacturedProduct') : null;
      const manufacturedMaterial = manufacturedProduct ? getFirstElement(manufacturedProduct, 'manufacturedMaterial') : null;

      let name = '';
      let code = 'N/A';
      if (manufacturedMaterial) {
        const codeEl = getFirstElement(manufacturedMaterial, 'code');
        if (codeEl) {
          name = getAttr(codeEl, 'displayName');
          code = getAttr(codeEl, 'code') || 'N/A';
        }
        if (!name) {
          const nameEl = getFirstElement(manufacturedMaterial, 'name');
          if (nameEl && nameEl.textContent) name = nameEl.textContent.trim();
        }
      }

      let dose = '';
      const doseQty = getFirstElement(entry, 'doseQuantity');
      if (doseQty) {
        const v = getAttr(doseQty, 'value');
        const u = getAttr(doseQty, 'unit');
        if (v) dose = `${v} ${u}`.trim();
      }

      let route = '';
      const routeCode = getFirstElement(entry, 'routeCode');
      if (routeCode) route = getAttr(routeCode, 'displayName') || getAttr(routeCode, 'code');

      const sig = [dose, route].filter(Boolean).join(' via ') || 'As directed';

      let status = 'active';
      const statusEl = getFirstElement(entry, 'statusCode');
      if (statusEl && getAttr(statusEl, 'code')) status = getAttr(statusEl, 'code');

      let date = 'N/A';
      const effTime = getFirstElement(entry, 'effectiveTime');
      if (effTime) {
        const low = getFirstElement(effTime, 'low');
        if (low && getAttr(low, 'value')) date = parseHL7Date(getAttr(low, 'value'));
        else if (getAttr(effTime, 'value')) date = parseHL7Date(getAttr(effTime, 'value'));
      }

      if (name) {
        medications.push({ name, code, status, sig, date });
      }
    });
  }

  // Problems
  const problems: Problem[] = [];
  const probSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.5.1', '2.16.840.1.113883.10.20.22.2.5'], ['problem', 'condition']);
  if (probSection) {
    const obsList = getElements(probSection, 'observation');
    obsList.forEach(obs => {
      const valEl = getFirstElement(obs, 'value');
      const codeEl = getFirstElement(obs, 'code');
      const name = (valEl ? getAttr(valEl, 'displayName') : '') || (codeEl ? getAttr(codeEl, 'displayName') : '');
      const code = (valEl ? getAttr(valEl, 'code') : '') || (codeEl ? getAttr(codeEl, 'code') : '') || 'N/A';

      let status = 'active';
      const statusEl = getFirstElement(obs, 'statusCode');
      if (statusEl && getAttr(statusEl, 'code')) status = getAttr(statusEl, 'code');

      let onset_date = 'N/A';
      const effTime = getFirstElement(obs, 'effectiveTime');
      if (effTime) {
        const low = getFirstElement(effTime, 'low');
        if (low && getAttr(low, 'value')) onset_date = parseHL7Date(getAttr(low, 'value'));
        else if (getAttr(effTime, 'value')) onset_date = parseHL7Date(getAttr(effTime, 'value'));
      }

      if (name && !problems.some(p => p.name === name)) {
        problems.push({ name, code, status, onset_date });
      }
    });
  }

  // Allergies
  const allergies: Allergy[] = [];
  const allergySection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.6.1', '2.16.840.1.113883.10.20.22.2.6'], ['allergy', 'adverse']);
  if (allergySection) {
    const obsList = getElements(allergySection, 'observation');
    obsList.forEach(obs => {
      const playingEntity = getFirstElement(obs, 'playingEntity');
      const codeEl = playingEntity ? getFirstElement(playingEntity, 'code') : getFirstElement(obs, 'code');
      const substance = codeEl ? getAttr(codeEl, 'displayName') : '';

      let reaction = 'N/A';
      let severity = 'N/A';

      const relObs = getElements(obs, 'observation');
      relObs.forEach(rel => {
        const val = getFirstElement(rel, 'value');
        if (val) {
          const disp = getAttr(val, 'displayName');
          if (disp) {
            if (['mild', 'moderate', 'severe'].some(s => disp.toLowerCase().includes(s))) {
              severity = disp;
            } else {
              reaction = disp;
            }
          }
        }
      });

      let status = 'active';
      const statusEl = getFirstElement(obs, 'statusCode');
      if (statusEl && getAttr(statusEl, 'code')) status = getAttr(statusEl, 'code');

      if (substance && !allergies.some(a => a.substance === substance)) {
        allergies.push({ substance, reaction, severity, status });
      }
    });
  }

  // Immunizations
  const immunizations: Immunization[] = [];
  const immSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.2.1', '2.16.840.1.113883.10.20.22.2.2'], ['immunization', 'vaccine']);
  if (immSection) {
    const entries = getElements(immSection, 'substanceAdministration');
    entries.forEach(entry => {
      const consumable = getFirstElement(entry, 'consumable');
      const manufacturedProduct = consumable ? getFirstElement(consumable, 'manufacturedProduct') : null;
      const manufacturedMaterial = manufacturedProduct ? getFirstElement(manufacturedProduct, 'manufacturedMaterial') : null;

      let vaccine = '';
      if (manufacturedMaterial) {
        const codeEl = getFirstElement(manufacturedMaterial, 'code');
        if (codeEl) vaccine = getAttr(codeEl, 'displayName');
      }

      let date = 'N/A';
      const effTime = getFirstElement(entry, 'effectiveTime');
      if (effTime && getAttr(effTime, 'value')) date = parseHL7Date(getAttr(effTime, 'value'));

      let status = 'completed';
      const statusEl = getFirstElement(entry, 'statusCode');
      if (statusEl && getAttr(statusEl, 'code')) status = getAttr(statusEl, 'code');

      if (vaccine) {
        immunizations.push({ vaccine, date, status });
      }
    });
  }

  // Vitals
  const vitals: Vital[] = [];
  const vitalsSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.4.1', '2.16.840.1.113883.10.20.22.2.4'], ['vital']);
  if (vitalsSection) {
    const obsList = getElements(vitalsSection, 'observation');
    obsList.forEach(obs => {
      const codeEl = getFirstElement(obs, 'code');
      const valEl = getFirstElement(obs, 'value');
      const name = codeEl ? getAttr(codeEl, 'displayName') : '';
      const value = valEl ? getAttr(valEl, 'value') : '';
      const unit = valEl ? getAttr(valEl, 'unit') : '';

      let date = 'N/A';
      const effTime = getFirstElement(obs, 'effectiveTime');
      if (effTime && getAttr(effTime, 'value')) date = parseHL7Date(getAttr(effTime, 'value'));

      if (name && value) {
        vitals.push({ name, value, unit, date });
      }
    });
  }

  // Procedures
  const procedures: Procedure[] = [];
  const procSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.7.1', '2.16.840.1.113883.10.20.22.2.7'], ['procedure']);
  if (procSection) {
    const procs = getElements(procSection, 'procedure');
    procs.forEach(p => {
      const codeEl = getFirstElement(p, 'code');
      const name = codeEl ? getAttr(codeEl, 'displayName') : '';

      let date = 'N/A';
      const effTime = getFirstElement(p, 'effectiveTime');
      if (effTime) {
        if (getAttr(effTime, 'value')) date = parseHL7Date(getAttr(effTime, 'value'));
        else {
          const low = getFirstElement(effTime, 'low');
          if (low && getAttr(low, 'value')) date = parseHL7Date(getAttr(low, 'value'));
        }
      }

      let status = 'completed';
      const statusEl = getFirstElement(p, 'statusCode');
      if (statusEl && getAttr(statusEl, 'code')) status = getAttr(statusEl, 'code');

      if (name) {
        procedures.push({ name, date, status });
      }
    });
  }

  // Social History
  const social_history: SocialHistoryItem[] = [];
  const socialSection = findSection(xmlDoc, ['2.16.840.1.113883.10.20.22.2.17'], ['social history', 'smoking']);
  if (socialSection) {
    const obsList = getElements(socialSection, 'observation');
    obsList.forEach(obs => {
      const codeEl = getFirstElement(obs, 'code');
      const valEl = getFirstElement(obs, 'value');
      const category = codeEl ? getAttr(codeEl, 'displayName') : 'Observation';
      const observation = valEl ? (getAttr(valEl, 'displayName') || (valEl.textContent || '').trim()) : '';

      let date = 'N/A';
      const effTime = getFirstElement(obs, 'effectiveTime');
      if (effTime && getAttr(effTime, 'value')) date = parseHL7Date(getAttr(effTime, 'value'));

      if (category && observation) {
        social_history.push({ category, observation, date });
      }
    });
  }

  const durationMs = (performance.now() - startTime).toFixed(1);

  return {
    parseApiObject: {
      patient: patientData,
      medications,
      problems,
      allergies,
      immunizations,
      vitals,
      procedures,
      social_history
    },
    durationMs
  };
}

// ==========================================
// TYPED JSON TREE VIEWER COMPONENT
// ==========================================

function JsonNode({ name, value, isLast = true }: JsonNodeProps) {
  const [isOpen, setIsOpen] = useState<boolean>(true);

  if (value === null || value === undefined) {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
        {name && <span style={{ color: '#9333ea', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>null</span>
        {!isLast && <span style={{ color: '#94a3b8' }}>,</span>}
      </div>
    );
  }

  if (isReactElementOrInternal(value)) {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
        {name && <span style={{ color: '#9333ea', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#0284c7', fontStyle: 'italic' }}>[React Element]</span>
        {!isLast && <span style={{ color: '#94a3b8' }}>,</span>}
      </div>
    );
  }

  if (typeof value === 'string') {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
        {name && <span style={{ color: '#9333ea', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#047857' }}>"{value}"</span>
        {!isLast && <span style={{ color: '#94a3b8' }}>,</span>}
      </div>
    );
  }

  if (typeof value === 'number') {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
        {name && <span style={{ color: '#9333ea', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#d97706' }}>{value}</span>
        {!isLast && <span style={{ color: '#94a3b8' }}>,</span>}
      </div>
    );
  }

  if (typeof value === 'boolean') {
    return (
      <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
        {name && <span style={{ color: '#9333ea', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#e11d48' }}>{String(value)}</span>
        {!isLast && <span style={{ color: '#94a3b8' }}>,</span>}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const objValue = value as Record<string, unknown>;
  const validKeys = isArray
    ? []
    : Object.keys(objValue).filter(k => k !== '$$typeof' && k !== '_owner' && k !== '_store');
  const count = isArray ? (value as unknown[]).length : validKeys.length;

  return (
    <div style={{ fontFamily: 'monospace', fontSize: '12px', padding: '2px 0' }}>
      <div
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', padding: '2px 4px', borderRadius: '4px', userSelect: 'none' }}
        onClick={() => setIsOpen(!isOpen)}
      >
        {isOpen ? <IconChevronDown className="w-4 h-4" /> : <IconChevronRight className="w-4 h-4" />}
        {name && <span style={{ color: '#7e22ce', fontWeight: 600 }}>"{renderString(name)}": </span>}
        <span style={{ color: '#475569' }}>{isArray ? '[' : '{'}</span>
        {!isOpen && (
          <span style={{ color: '#64748b', fontSize: '10px', background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px', fontFamily: 'sans-serif' }}>
            {count} {isArray ? 'items' : 'keys'}
          </span>
        )}
        {!isOpen && <span style={{ color: '#475569' }}>{isArray ? ']' : '}'}</span>}
      </div>

      {isOpen && (
        <div style={{ paddingLeft: '16px', borderLeft: '1px solid #cbd5e1', margin: '2px 0' }}>
          {isArray
            ? (value as unknown[]).map((item, idx) => (
                <JsonNode key={idx} value={item} isLast={idx === (value as unknown[]).length - 1} />
              ))
            : validKeys.map((key, idx, arr) => (
                <JsonNode
                  key={key}
                  name={key}
                  value={objValue[key]}
                  isLast={idx === arr.length - 1}
                />
              ))}
        </div>
      )}

      {isOpen && <div style={{ color: '#475569' }}>{isArray ? ']' : '}'}{!isLast && ','}</div>}
    </div>
  );
}

// ==========================================
// MAIN REACT APP COMPONENT
// ==========================================

export default function App() {
  Parse.initialize(PARSE_APP_ID, PARSE_JS_KEY);
  Parse.serverURL = PARSE_SERVER_URL;
  Parse.setAsyncStorage(window.localStorage);

  const [xmlText, setXmlText] = useState<string>('');
  const [fileName, setFileName] = useState<string>('No file selected');
  const [activeTab, setActiveTab] = useState<'visual' | 'json' | 'xml' | 'parse-api'>('visual');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [toast, setToast] = useState<ToastNotification | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  // Parse API Storage State
  const [savedRecords, setSavedRecords] = useState<SavedParseRecord[]>([]);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  // Parse C-CDA document memoized
  const parsedData = useMemo<ParsedResult>(() => {
    if (!xmlText.trim()) {
      return {
        parseApiObject: {
          patient: { name: 'No Document Uploaded', birth_date: 'N/A', gender: 'N/A', marital_status: 'N/A', address: 'N/A', telephone: 'N/A' },
          medications: [],
          problems: [],
          allergies: [],
          immunizations: [],
          vitals: [],
          procedures: [],
          social_history: []
        },
        durationMs: '0'
      };
    }
    try {
      return parseCCDA(xmlText);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown parsing error';
      return {
        error: errorMessage,
        parseApiObject: {
          patient: { name: 'Error', birth_date: '', gender: '', marital_status: '', address: '', telephone: '' },
          medications: [],
          problems: [],
          allergies: [],
          immunizations: [],
          vitals: [],
          procedures: [],
          social_history: []
        },
        durationMs: '0'
      };
    }
  }, [xmlText]);

  const { parseApiObject, durationMs, error } = parsedData;
  const { patient, medications, problems, allergies, immunizations, vitals, procedures, social_history } = parseApiObject;

  // Notification Toast Helper
  const showNotification = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'success') => {
    setToast({ msg: renderString(msg), type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Save to Parse API using official Parse JS SDK (new Parse.Object and .save())
  const handleSaveToParseApi = async () => {
    setIsSyncing(true);
    setSyncStatus('Saving record via Parse.Object.save()...');

    try {
      const CcdaClass = Parse.Object.extend(PARSE_CLASS_NAME);
      const record = new CcdaClass();

      record.set('fileName', fileName);
      record.set('patientName', patient.name);
      record.set('patientDob', patient.birth_date);
      record.set('parseApiObject', parseApiObject);

      const savedObject = await record.save();

      const newRecord: SavedParseRecord = {
        objectId: savedObject.id,
        createdAt: savedObject.createdAt ? savedObject.createdAt.toISOString() : new Date().toISOString(),
        updatedAt: savedObject.updatedAt ? savedObject.updatedAt.toISOString() : new Date().toISOString(),
        fileName,
        patientName: patient.name,
        patientDob: patient.birth_date,
        parseApiObject
      };
      setSavedRecords(prev => [newRecord, ...prev]);
      showNotification(`Saved to Parse API via Parse.Object (ID: ${savedObject.id})!`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save to Parse API';
      showNotification(`Parse SDK Save Error: ${msg}`, 'error');
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  // Fetch Records from Parse API using Parse.Query
  const handleFetchFromParseApi = async () => {
    setIsSyncing(true);
    setSyncStatus('Retrieving records via Parse.Query...');

    try {
      const query = new Parse.Query(PARSE_CLASS_NAME);
      query.descending('createdAt');
      const results = await query.find();

      const records: SavedParseRecord[] = results.map((r: any) => ({
        objectId: r.id,
        createdAt: r.createdAt ? r.createdAt.toISOString() : new Date().toISOString(),
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : new Date().toISOString(),
        fileName: r.get('fileName') || 'ccda_record.xml',
        patientName: r.get('patientName') || r.get('parseApiObject')?.patient?.name || 'Unknown Patient',
        patientDob: r.get('patientDob') || r.get('parseApiObject')?.patient?.birth_date || 'N/A',
        parseApiObject: r.get('parseApiObject') || {}
      }));

      setSavedRecords(records);
      showNotification(`Successfully retrieved ${records.length} Parse API records!`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fetch failed';
      showNotification(`Parse SDK Fetch Error: ${msg}`, 'error');
    } finally {
      setIsSyncing(false);
      setSyncStatus(null);
    }
  };

  const handleLoadSavedRecord = (record: SavedParseRecord) => {
    setFileName(record.fileName);
    showNotification(`Loaded ${record.patientName} (${record.objectId}) into Parse API Viewer!`, 'success');
    setActiveTab('json');
  };

  // Delete Record from Parse API using object.destroy()
  const handleDeleteFromParseApi = async (objectId: string) => {
    setIsSyncing(true);
    try {
      const query = new Parse.Query(PARSE_CLASS_NAME);
      const objectToDelete = await query.get(objectId);
      await objectToDelete.destroy();

      setSavedRecords(prev => prev.filter(r => r.objectId !== objectId));
      showNotification(`Deleted record ${objectId} via Parse SDK`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      showNotification(`Parse SDK Delete Error: ${msg}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt: ProgressEvent<FileReader>) => {
        if (evt.target?.result && typeof evt.target.result === 'string') {
          setXmlText(evt.target.result);
          setFileName(file.name);
          showNotification(`Successfully parsed ${file.name}`);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      const file = e.dataTransfer.files[0];
      const reader = new FileReader();
      reader.onload = (evt: ProgressEvent<FileReader>) => {
        if (evt.target?.result && typeof evt.target.result === 'string') {
          setXmlText(evt.target.result);
          setFileName(file.name);
          showNotification(`Uploaded & parsed ${file.name}`);
        }
      };
      reader.readAsText(file);
    }
  };

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(parseApiObject, null, 2));
    setIsCopied(true);
    showNotification('Parse API JSON object copied to clipboard!');
    setTimeout(() => setIsCopied(false), 2000);
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(parseApiObject, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName.replace(/\.[^/.]+$/, "")}_parse_api.json`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification('Downloaded Parse API JSON object!');
  };

  const filterList = <T,>(list: T[], keys: (keyof T)[]): T[] => {
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter(item =>
      keys.some(k => renderString(item[k]).toLowerCase().includes(q))
    );
  };

  const filteredMeds = useMemo(() => filterList(medications, ['name', 'code', 'sig', 'status']), [medications, searchQuery]);
  const filteredProblems = useMemo(() => filterList(problems, ['name', 'code', 'status']), [problems, searchQuery]);
  const filteredAllergies = useMemo(() => filterList(allergies, ['substance', 'reaction', 'severity']), [allergies, searchQuery]);
  const filteredImmunizations = useMemo(() => filterList(immunizations, ['vaccine', 'status']), [immunizations, searchQuery]);
  const filteredVitals = useMemo(() => filterList(vitals, ['name', 'value', 'unit']), [vitals, searchQuery]);
  const filteredProcedures = useMemo(() => filterList(procedures, ['name', 'status']), [procedures, searchQuery]);
  const filteredSocial = useMemo(() => filterList(social_history, ['category', 'observation']), [social_history, searchQuery]);

  const totalEntities = medications.length + problems.length + allergies.length + immunizations.length + vitals.length + procedures.length + social_history.length;

  return (
    <>
      <NavigationBar />
      <div className="ccda-app">
        {/* EMBEDDED CUSTOM STYLES */}
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body, html { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; min-height: 100vh; }
          
          .w-4 { width: 16px; height: 16px; }
          .w-6 { width: 24px; height: 24px; }
          
          .ccda-app { display: flex; flex-direction: column; min-height: 100vh; }
          
          .main-content { flex: 1; max-width: 1280px; width: 100%; margin: 0 auto; padding: 24px 20px; display: flex; flex-direction: column; gap: 24px; }
          
          .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
          .card-dark { background: #0f172a; border: 1px solid #1e293b; color: #f8fafc; border-radius: 16px; padding: 18px; display: flex; flex-direction: column; justify-content: space-between; gap: 16px; }
          
          .dropzone { border: 2px dashed #cbd5e1; background: #f8fafc; border-radius: 12px; padding: 32px 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; cursor: pointer; transition: all 0.2s; }
          .dropzone:hover { border-color: #0284c7; background: #f0f9ff; }
          .dropzone-icon { width: 48px; height: 48px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; color: #475569; margin-bottom: 12px; }
          
          .grid-upload { display: grid; grid-template-columns: 2fr 1fr; gap: 24px; }
          @media (max-width: 900px) { .grid-upload { grid-template-columns: 1fr; } }
          
          .meta-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #cbd5e1; margin-bottom: 8px; }
          .btn-action-purple { width: 100%; padding: 8px 12px; background: #7e22ce; color: white; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
          .btn-action-purple:hover { background: #6b21a8; }
          .btn-action-sky { flex: 1; padding: 6px 12px; background: #0284c7; color: white; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
          .btn-action-sky:hover { background: #0369a1; }
          .btn-action-outline { flex: 1; padding: 6px 12px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
          .btn-action-outline:hover { background: #334155; }
          .btn-preset { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; border-radius: 8px; cursor: pointer; transition: all 0.15s; }
          .btn-preset:hover { background: #e2e8f0; }
          
          .tab-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; flex-wrap: wrap; }
          .tab-group { display: flex; align-items: center; gap: 6px; overflow-x: auto; }
          .tab-btn { padding: 8px 16px; font-size: 13px; font-weight: 700; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #64748b; cursor: pointer; display: flex; align-items: center; gap: 8px; }
          .tab-btn:hover { background: #e2e8f0; color: #0f172a; }
          .tab-btn-active { background: #e0f2fe; color: #0369a1; border-color: #bae6fd; }
          .tab-btn-active-purple { background: #f3e8ff; color: #6b21a8; border-color: #e9d5ff; }
          .tab-btn-active-emerald { background: #d1fae5; color: #065f46; border-color: #a7f3d0; }
          
          .search-box { position: relative; width: 260px; }
          .search-input { width: 100%; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 12px 6px 32px; font-size: 12px; color: #0f172a; outline: none; }
          .search-icon { position: absolute; left: 10px; top: 8px; color: #94a3b8; }
          
          .patient-hero { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
          .patient-avatar { width: 64px; height: 64px; border-radius: 16px; background: linear-gradient(135deg, #0284c7, #06b6d4); color: white; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; flex-shrink: 0; }
          
          .metrics-grid { display: flex; flex-wrap: wrap; gap: 12px; background: #f1f5f9; padding: 14px; border-radius: 12px; border: 1px solid #e2e8f0; }
          .metric-item { flex: 1; min-width: 75px; text-align: center; padding: 2px 8px; }
          .metric-label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; display: block; white-space: nowrap; margin-bottom: 2px; }
          .metric-val { font-size: 18px; font-weight: 800; display: block; }
          
          .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
          @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
          
          .section-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; }
          .section-header { padding: 12px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; }
          .section-title { font-size: 14px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 10px; }
          .section-icon { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
          
          .badge { padding: 3px 8px; font-size: 11px; font-weight: 700; border-radius: 9999px; display: inline-block; white-space: nowrap; }
          .badge-emerald { background: #d1fae5; color: #065f46; border: 1px solid #a7f3d0; }
          .badge-rose { background: #ffe4e6; color: #9f1239; border: 1px solid #fecdd3; }
          .badge-amber { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
          .badge-sky { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
          .badge-purple { background: #f3e8ff; color: #6b21a8; border: 1px solid #e9d5ff; }
          .badge-indigo { background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; }
          .badge-teal { background: #ccfbf1; color: #115e59; border: 1px solid #99f6e4; }
          
          .table-custom { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
          .table-custom th { padding: 10px 12px; font-weight: 600; color: #64748b; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
          .table-custom td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; color: #334155; }
          .table-custom tr:hover td { background: #f8fafc; }
          
          .toast { position: fixed; top: 16px; right: 16px; z-index: 50; display: flex; align-items: center; gap: 10px; padding: 12px 18px; border-radius: 12px; font-size: 12px; font-weight: 600; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border: 1px solid; }
          .toast-success { background: #ecfdf5; color: #065f46; border-color: #a7f3d0; }
          .toast-error { background: #fff1f2; color: #9f1239; border-color: #fecdd3; }
          .toast-info { background: #f0f9ff; color: #0369a1; border-color: #bae6fd; }
          
          .footer { background: #ffffff; border-top: 1px solid #e2e8f0; padding: 16px 0; margin-top: auto; font-size: 12px; color: #64748b; }
        `}</style>

        {/* TOAST NOTIFICATION */}
        {toast && (
          <div className={`toast toast-${toast.type}`}>
            {toast.type === 'error' ? <IconAlertCircle className="w-4 h-4" /> : <IconCheckCircle className="w-4 h-4" />}
            <span>{renderString(toast.msg)}</span>
          </div>
        )}

        {/* MAIN BODY */}
        <main className="main-content">

          {/* UPLOAD & META CARD */}
          <section className="card">
            <div className="grid-upload">
              <div
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => document.getElementById('xmlFileInput')?.click()}
              >
                <input
                  type="file"
                  id="xmlFileInput"
                  accept=".xml,.ccda,.txt"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
                <div className="dropzone-icon">
                  <IconFileUp className="w-6 h-6" />
                </div>
                <p style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>
                  Click to upload or drag & drop C-CDA XML file
                </p>
                <p style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
                  Parses HL7 C-CDA into JSON Parse API Format
                </p>
              </div>

              <div className="card-dark">
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '12px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>Active Document</span>
                    <span className={`badge ${error ? 'badge-rose' : 'badge-emerald'}`}>
                      {error ? 'PARSE ERROR' : 'PARSED OK'}
                    </span>
                  </div>

                  <div className="meta-row">
                    <span style={{ color: '#94a3b8' }}>File Name:</span>
                    <span style={{ fontFamily: 'monospace', color: '#38bdf8', fontWeight: 600 }}>{renderString(fileName)}</span>
                  </div>
                  <div className="meta-row">
                    <span style={{ color: '#94a3b8' }}>Parse Speed:</span>
                    <span style={{ fontFamily: 'monospace', color: '#34d399' }}>{renderString(durationMs)} ms</span>
                  </div>
                  <div className="meta-row">
                    <span style={{ color: '#94a3b8' }}>Total Entities:</span>
                    <span style={{ fontFamily: 'monospace', color: '#ffffff', fontWeight: 700 }}>{totalEntities} items</span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '10px', borderTop: '1px solid #334155' }}>
                  <button onClick={handleSaveToParseApi} disabled={isSyncing || !!error} className="btn-action-purple">
                    <IconUploadCloud className="w-4 h-4" />
                    {isSyncing ? renderString(syncStatus || 'Saving...') : 'Save to Cloud'}
                  </button>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={copyJson} className="btn-action-sky">
                      {isCopied ? <IconCheck className="w-4 h-4" /> : <IconCopy className="w-4 h-4" />}
                      {isCopied ? 'Copied!' : 'Copy JSON'}
                    </button>
                    <button onClick={downloadJson} className="btn-action-outline">
                      <IconDownload className="w-4 h-4" /> Export
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* TAB BAR & SEARCH */}
          <div className="tab-bar">
            <div className="tab-group">
              <button
                onClick={() => setActiveTab('visual')}
                className={`tab-btn ${activeTab === 'visual' ? 'tab-btn-active' : ''}`}
              >
                <IconLayoutDashboard className="w-4 h-4" /> Visual EHR Dashboard
              </button>
              <button
                onClick={() => setActiveTab('json')}
                className={`tab-btn ${activeTab === 'json' ? 'tab-btn-active-purple' : ''}`}
              >
                <IconCode className="w-4 h-4" /> Parse API JSON Object
              </button>
              <button
                onClick={() => setActiveTab('parse-api')}
                className={`tab-btn ${activeTab === 'parse-api' ? 'tab-btn-active-emerald' : ''}`}
              >
                <IconCloud className="w-4 h-4" /> Parse API Storage ({savedRecords.length})
              </button>
              <button
                onClick={() => setActiveTab('xml')}
                className={`tab-btn ${activeTab === 'xml' ? 'tab-btn-active' : ''}`}
              >
                <IconFileCode className="w-4 h-4" /> Source C-CDA XML
              </button>
            </div>

            {activeTab === 'visual' && (
              <div className="search-box">
                <IconSearch className="search-icon w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search clinical records..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
              </div>
            )}
          </div>

          {/* TAB 1: VISUAL EHR DASHBOARD */}
          {activeTab === 'visual' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              {/* HERO DEMOGRAPHICS */}
              <div className="patient-hero">
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div className="patient-avatar">
                    {renderString(patient.name).split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <h2 style={{ fontSize: '22px', fontWeight: 800, color: '#0f172a' }}>{renderString(patient.name)}</h2>
                      <span className="badge badge-sky">{renderString(patient.gender)}</span>
                      <span className="badge badge-purple">{renderString(patient.marital_status)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px', color: '#475569', marginTop: '6px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IconCalendar className="w-4 h-4" /> DOB: <strong>{renderString(patient.birth_date)}</strong>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IconPhone className="w-4 h-4" /> Phone: <strong>{renderString(patient.telephone)}</strong>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <IconMapPin className="w-4 h-4" /> Address: <strong>{renderString(patient.address)}</strong>
                      </span>
                    </div>
                  </div>
                </div>

                {/* METRICS COUNTER GRID */}
                <div className="metrics-grid">
                  <div className="metric-item">
                    <span className="metric-label">Meds</span>
                    <span className="metric-val" style={{ color: '#059669' }}>{medications.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Problems</span>
                    <span className="metric-val" style={{ color: '#e11d48' }}>{problems.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Allergies</span>
                    <span className="metric-val" style={{ color: '#d97706' }}>{allergies.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Imm</span>
                    <span className="metric-val" style={{ color: '#0284c7' }}>{immunizations.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Vitals</span>
                    <span className="metric-val" style={{ color: '#4f46e5' }}>{vitals.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Procedures</span>
                    <span className="metric-val" style={{ color: '#7e22ce' }}>{procedures.length}</span>
                  </div>
                  <div className="metric-item">
                    <span className="metric-label">Social</span>
                    <span className="metric-val" style={{ color: '#0d9488' }}>{social_history.length}</span>
                  </div>
                </div>
              </div>

              {/* SECTIONS CARDS */}
              <div className="grid-2">

                {/* MEDICATIONS */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#d1fae5', color: '#047857' }}>
                        <IconPill className="w-4 h-4" />
                      </div>
                      Medications
                    </div>
                    <span className="badge badge-emerald">{filteredMeds.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Name</th><th>RxNorm</th><th>Sig</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {filteredMeds.map((m, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(m.name)}</td>
                            <td style={{ fontFamily: 'monospace', color: '#64748b' }}>{renderString(m.code)}</td>
                            <td>{renderString(m.sig)}</td>
                            <td><span className="badge badge-emerald">{renderString(m.status)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* PROBLEMS */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#ffe4e6', color: '#be123c' }}>
                        <IconAlertCircle className="w-4 h-4" />
                      </div>
                      Problems &amp; Conditions
                    </div>
                    <span className="badge badge-rose">{filteredProblems.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Condition</th><th>SNOMED</th><th>Onset Date</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {filteredProblems.map((p, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(p.name)}</td>
                            <td style={{ fontFamily: 'monospace', color: '#64748b' }}>{renderString(p.code)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(p.onset_date)}</td>
                            <td><span className="badge badge-rose">{renderString(p.status)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* ALLERGIES */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#fef3c7', color: '#b45309' }}>
                        <IconAlertTriangle className="w-4 h-4" />
                      </div>
                      Allergies &amp; Reactions
                    </div>
                    <span className="badge badge-amber">{filteredAllergies.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Substance</th><th>Reaction</th><th>Severity</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {filteredAllergies.map((a, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(a.substance)}</td>
                            <td>{renderString(a.reaction)}</td>
                            <td>
                              <span className={`badge ${renderString(a.severity).toLowerCase().includes('severe') ? 'badge-rose' : 'badge-amber'}`}>
                                {renderString(a.severity)}
                              </span>
                            </td>
                            <td style={{ fontSize: '11px', textTransform: 'uppercase' }}>{renderString(a.status)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* IMMUNIZATIONS */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#e0f2fe', color: '#0369a1' }}>
                        <IconSyringe className="w-4 h-4" />
                      </div>
                      Immunizations
                    </div>
                    <span className="badge badge-sky">{filteredImmunizations.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Vaccine Name</th><th>Date</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {filteredImmunizations.map((imm, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(imm.vaccine)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(imm.date)}</td>
                            <td><span className="badge badge-sky">{renderString(imm.status)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* VITALS */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#e0e7ff', color: '#3730a3' }}>
                        <IconActivity className="w-4 h-4" />
                      </div>
                      Vital Signs
                    </div>
                    <span className="badge badge-indigo">{filteredVitals.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Measurement</th><th>Value</th><th>Unit</th><th>Date</th></tr>
                      </thead>
                      <tbody>
                        {filteredVitals.map((v, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(v.name)}</td>
                            <td style={{ fontWeight: 700, color: '#0284c7' }}>{renderString(v.value)}</td>
                            <td>{renderString(v.unit)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(v.date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* PROCEDURES */}
                <div className="section-card">
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#f3e8ff', color: '#6b21a8' }}>
                        <IconScissors className="w-4 h-4" />
                      </div>
                      Procedures
                    </div>
                    <span className="badge badge-purple">{filteredProcedures.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Procedure Name</th><th>Date</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {filteredProcedures.map((proc, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(proc.name)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(proc.date)}</td>
                            <td><span className="badge badge-purple">{renderString(proc.status)}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* SOCIAL HISTORY */}
                <div className="section-card" style={{ gridColumn: '1 / -1' }}>
                  <div className="section-header">
                    <div className="section-title">
                      <div className="section-icon" style={{ background: '#ccfbf1', color: '#0f766e' }}>
                        <IconUsers className="w-4 h-4" />
                      </div>
                      Social History &amp; Health Factors
                    </div>
                    <span className="badge badge-teal">{filteredSocial.length} items</span>
                  </div>
                  <div style={{ padding: '16px', overflowX: 'auto' }}>
                    <table className="table-custom">
                      <thead>
                        <tr><th>Category</th><th>Observation / Details</th><th>Date</th></tr>
                      </thead>
                      <tbody>
                        {filteredSocial.map((s, i) => (
                          <tr key={i}>
                            <td style={{ fontWeight: 600 }}>{renderString(s.category)}</td>
                            <td style={{ color: '#0f766e', fontWeight: 500 }}>{renderString(s.observation)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(s.date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* TAB 2: PARSE API JSON OBJECT VIEWER */}
          {activeTab === 'json' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>Parse API JSON Object Output</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={copyJson} className="btn-action-purple" style={{ width: 'auto', padding: '6px 14px' }}>
                    <IconCopy className="w-4 h-4" /> Copy JSON
                  </button>
                  <button onClick={downloadJson} className="btn-preset">
                    <IconDownload className="w-4 h-4" /> Download
                  </button>
                </div>
              </div>
              <div style={{ padding: '24px', background: '#ffffff', overflowX: 'auto', maxHeight: '600px' }}>
                <JsonNode value={parseApiObject} />
              </div>
            </div>
          )}

          {/* TAB 3: PARSE API STORAGE */}
          {activeTab === 'parse-api' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ fontSize: '16px', fontWeight: 700 }}>Cloud Controls</h3>
                  {/* <p style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                    Target Class: <span style={{ fontFamily: 'monospace', color: '#0284c7' }}>new Parse.Object("{PARSE_CLASS_NAME}")</span>
                  </p> */}
                </div>

                <div style={{ display: 'flex', gap: '12px' }}>
                  <button onClick={handleSaveToParseApi} disabled={isSyncing} className="btn-action-purple" style={{ width: 'auto', padding: '8px 16px' }}>
                    <IconUploadCloud className="w-4 h-4" /> Save to Cloud
                  </button>
                  <button onClick={handleFetchFromParseApi} disabled={isSyncing} className="btn-preset" style={{ padding: '8px 16px' }}>
                    <IconRefreshCw className="w-4 h-4" /> Fetch from Cloud
                  </button>
                </div>
              </div>

              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontWeight: 700, fontSize: '13px' }}>
                  Retrieved Parse API Objects ({savedRecords.length})
                </div>
                <div style={{ padding: '16px', overflowX: 'auto' }}>
                  {savedRecords.length === 0 ? (
                    <div style={{ padding: '32px', textAlign: 'center', color: '#94a3b8', fontSize: '12px' }}>
                      No records retrieved yet. Click "Fetch from Cloud" or "Save to Cloud".
                    </div>
                  ) : (
                    <table className="table-custom">
                      <thead>
                        <tr><th>Object ID</th><th>Patient Name</th><th>File Name</th><th>Created At</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
                      </thead>
                      <tbody>
                        {savedRecords.map(rec => (
                          <tr key={rec.objectId}>
                            <td style={{ fontFamily: 'monospace', fontWeight: 700, color: '#7e22ce' }}>{renderString(rec.objectId)}</td>
                            <td style={{ fontWeight: 600 }}>{renderString(rec.patientName)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{renderString(rec.fileName)}</td>
                            <td style={{ fontFamily: 'monospace' }}>{new Date(rec.createdAt).toLocaleString()}</td>
                            <td style={{ textAlign: 'right' }}>
                              <button onClick={() => handleLoadSavedRecord(rec)} className="btn-preset" style={{ padding: '4px 8px', fontSize: '11px', marginRight: '6px' }}>
                                Load
                              </button>
                              <button onClick={() => handleDeleteFromParseApi(rec.objectId)} className="btn-preset" style={{ padding: '4px 8px', fontSize: '11px', color: '#e11d48', borderColor: '#fecdd3' }}>
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: RAW XML */}
          {activeTab === 'xml' && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'monospace' }}>Source C-CDA XML</span>
                <button onClick={() => { navigator.clipboard.writeText(xmlText); showNotification('XML copied to clipboard!'); }} className="btn-preset">
                  <IconCopy className="w-4 h-4" /> Copy XML
                </button>
              </div>
              <textarea
                value={xmlText}
                onChange={(e) => setXmlText(e.target.value)}
                style={{ width: '100%', height: '550px', padding: '20px', background: '#0f172a', color: '#f8fafc', fontFamily: 'monospace', fontSize: '12px', border: 'none', resize: 'none', lineHeight: 1.5 }}
                spellCheck={false}
              />
            </div>
          )}

        </main>

        {/* FOOTER */}
        <footer className="footer">
          <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <IconSparkles className="w-4 h-4 text-sky-600" />
              <span>Client-side C-CDA Parser &amp; Parse API Generator</span>
            </div>
            <span>Parse JS SDK Integration • Light Theme</span>
          </div>
        </footer>
      </div>
    </>
  );
}