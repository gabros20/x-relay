// x-client-transaction-id generator. Vendored + ported from
// Lqm1/x-client-transaction-id (MIT), adapted to Node: @std/encoding -> Buffer,
// crypto.subtle -> node:crypto. The byte-assembly is extracted into the pure
// `assembleTransactionId` so it can be unit-tested deterministically.
// Algorithm + constants: docs/ENGINE-RESEARCH.md §3.
import { createHash } from 'node:crypto';
import Cubic from './cubic.ts';
import type { XDocument, XElement } from './dom.ts';
import {
  AnimationFrameDataError,
  ClientTransactionNotInitializedError,
  IndicesNotInitializedError,
  KeyByteIndicesExtractionError,
  OnDemandFileFetchError,
  OnDemandFileUrlResolutionError,
  SiteVerificationKeyNotFoundError,
} from './errors.ts';
import { interpolate } from './interpolate.ts';
import { convertRotationToMatrix } from './rotation.ts';
import { floatToHex, isOdd } from './utils.ts';

const ON_DEMAND_CHUNK_NAME = 'ondemand.s';
const INDICES_REGEX = /\(\w\[(\d{1,2})\],\s*16\)/g;
const ON_DEMAND_FILE_HASH_REGEX =
  /(\d+):\s*["']ondemand\.s["'][\s\S]*?\}\)\[e\]\s*\|\|\s*e\)\s*\+\s*["']\.["']\s*\+\s*\(\{[\s\S]*?\b\1:\s*["']([a-zA-Z0-9_-]+)["']/s;

const DEFAULT_KEYWORD = 'obfiowerehiring';
const ADDITIONAL_RANDOM_NUMBER = 3;
/** X's custom epoch (seconds) subtracted from Unix time. Stable since 2023. */
const EPOCH_SECONDS = 1682924400;

function resolveOnDemandFileUrlFromRuntime(runtimeSource: string): string | null {
  const match = ON_DEMAND_FILE_HASH_REGEX.exec(runtimeSource);
  if (!match) return null;
  return `https://abs.twimg.com/responsive-web/client-web/${ON_DEMAND_CHUNK_NAME}.${match[2]}a.js`;
}

/**
 * Pure byte-assembly of a transaction id: SHA-256 of the data string, then
 * `[rnd, ...([keyBytes | timeBytes(LE) | hash[0:16] | 3] XOR rnd)]` base64'd
 * without padding. `randomNum` is injectable so the assembly is testable.
 */
export async function assembleTransactionId(
  keyBytes: number[],
  animationKey: string,
  method: string,
  path: string,
  timeNow: number,
  randomNum?: number,
): Promise<string> {
  const timeNowBytes = [
    timeNow & 0xff,
    (timeNow >> 8) & 0xff,
    (timeNow >> 16) & 0xff,
    (timeNow >> 24) & 0xff,
  ];

  const data = `${method}!${path}!${timeNow}${DEFAULT_KEYWORD}${animationKey}`;
  const hashBytes = [...createHash('sha256').update(data, 'utf8').digest()];

  const rnd = randomNum ?? Math.floor(Math.random() * 256);
  const bytesArr = [
    ...keyBytes,
    ...timeNowBytes,
    ...hashBytes.slice(0, 16),
    ADDITIONAL_RANDOM_NUMBER,
  ];
  const out = Uint8Array.from([rnd, ...bytesArr.map((b) => b ^ rnd)]);
  return Buffer.from(out).toString('base64').replace(/=/g, '');
}

/** Generates the x-client-transaction-id header value for X GraphQL requests. */
export class ClientTransaction {
  private homePageDocument: XDocument;
  private rowIndex: number | null = null;
  private keyByteIndices: number[] | null = null;
  private key: string | null = null;
  private keyBytes: number[] | null = null;
  private animationKey: string | null = null;
  private isInitialized = false;

  constructor(homePageDocument: XDocument) {
    this.homePageDocument = homePageDocument;
  }

  static async create(homePageDocument: XDocument): Promise<ClientTransaction> {
    const instance = new ClientTransaction(homePageDocument);
    await instance.initialize();
    return instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    [this.rowIndex, this.keyByteIndices] = await this.getIndices();
    this.key = this.getKey();
    this.keyBytes = getKeyBytes(this.key);
    this.animationKey = this.getAnimationKey(this.keyBytes);
    this.isInitialized = true;
  }

  private async getIndices(): Promise<[number, number[]]> {
    const onDemandFileUrl = this.getOnDemandFileUrl();
    const onDemandFileResponse = await fetch(onDemandFileUrl);
    if (!onDemandFileResponse.ok) {
      throw new OnDemandFileFetchError(
        onDemandFileUrl,
        onDemandFileResponse.status,
        onDemandFileResponse.statusText,
      );
    }
    const responseText = await onDemandFileResponse.text();

    const indices: number[] = [];
    INDICES_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null = INDICES_REGEX.exec(responseText);
    while (match !== null) {
      if (match[1] !== undefined) indices.push(Number.parseInt(match[1], 10));
      match = INDICES_REGEX.exec(responseText);
    }
    if (!indices.length) throw new KeyByteIndicesExtractionError();
    return [indices[0] ?? 0, indices.slice(1)];
  }

  private getOnDemandFileUrl(): string {
    const doc = this.homePageDocument;
    const runtimeSources = Array.from(doc.querySelectorAll('script'))
      .map((script) => script.textContent || '')
      .filter((text) => text.includes(ON_DEMAND_CHUNK_NAME));
    runtimeSources.push(doc.documentElement.outerHTML);

    for (const runtimeSource of runtimeSources) {
      const url = resolveOnDemandFileUrlFromRuntime(runtimeSource);
      if (url) return url;
    }
    throw new OnDemandFileUrlResolutionError();
  }

  private getKey(): string {
    const element = this.homePageDocument.querySelector("[name='twitter-site-verification']");
    const content = element ? (element.getAttribute('content') ?? '') : '';
    if (!content) throw new SiteVerificationKeyNotFoundError();
    return content;
  }

  private getFrames(): XElement[] {
    return Array.from(this.homePageDocument.querySelectorAll("[id^='loading-x-anim']"));
  }

  private get2dArray(keyBytes: number[]): number[][] {
    const frames = this.getFrames();
    if (!frames.length) return [[]];

    const frame = frames[(keyBytes[5] ?? 0) % 4];
    const firstChild = frame?.children[0];
    const targetChild = firstChild?.children[1];
    const dAttr = targetChild?.getAttribute('d') ?? null;
    if (dAttr === null) return [];

    const items = dAttr.substring(9).split('C');
    return items.map((item) => {
      const cleaned = item.replace(/[^\d]+/g, ' ').trim();
      const parts = cleaned === '' ? [] : cleaned.split(/\s+/);
      return parts.map((str) => Number.parseInt(str, 10));
    });
  }

  private solve(value: number, minVal: number, maxVal: number, rounding: boolean): number {
    const result = (value * (maxVal - minVal)) / 255 + minVal;
    return rounding ? Math.floor(result) : Math.round(result * 100) / 100;
  }

  private animate(frames: number[], targetTime: number): string {
    const fromColor = frames.slice(0, 3).concat(1).map(Number);
    const toColor = frames.slice(3, 6).concat(1).map(Number);
    const fromRotation = [0.0];
    const toRotation = [this.solve(frames[6] ?? 0, 60.0, 360.0, true)];

    const curves = frames
      .slice(7)
      .map((item, counter) => this.solve(item, isOdd(counter), 1.0, false));

    const val = new Cubic(curves).getValue(targetTime);
    const color = interpolate(fromColor, toColor, val).map((value) => (value > 0 ? value : 0));
    const rotation = interpolate(fromRotation, toRotation, val);
    const matrix = convertRotationToMatrix(rotation[0] ?? 0);

    const strArr: string[] = color.slice(0, -1).map((value) => Math.round(value).toString(16));
    for (const value of matrix) {
      let rounded = Math.round(value * 100) / 100;
      if (rounded < 0) rounded = -rounded;
      const hexValue = floatToHex(rounded);
      strArr.push(hexValue.startsWith('.') ? `0${hexValue}`.toLowerCase() : hexValue || '0');
    }
    strArr.push('0', '0');
    return strArr.join('').replace(/[.-]/g, '');
  }

  private getAnimationKey(keyBytes: number[]): string {
    const totalTime = 4096;
    if (this.rowIndex == null || this.keyByteIndices == null) {
      throw new IndicesNotInitializedError();
    }

    const rowIndex = (keyBytes[this.rowIndex] ?? 0) % 16;
    let frameTime = this.keyByteIndices.reduce((acc, idx) => acc * ((keyBytes[idx] ?? 0) % 16), 1);
    frameTime = Math.round(frameTime / 10) * 10;

    const arr = this.get2dArray(keyBytes);
    const frameRow = arr[rowIndex];
    if (!frameRow) throw new AnimationFrameDataError(rowIndex);

    return this.animate(frameRow, frameTime / totalTime);
  }

  /** Generates a transaction id for the given (method, path). Requires initialize(). */
  async generateTransactionId(method: string, path: string, timeNow?: number): Promise<string> {
    if (!this.isInitialized || this.keyBytes == null || this.animationKey == null) {
      throw new ClientTransactionNotInitializedError();
    }
    const t = timeNow ?? Math.floor((Date.now() - EPOCH_SECONDS * 1000) / 1000);
    return assembleTransactionId(this.keyBytes, this.animationKey, method, path, t);
  }
}

function getKeyBytes(key: string): number[] {
  return Array.from(Buffer.from(key, 'base64'));
}

export default ClientTransaction;
