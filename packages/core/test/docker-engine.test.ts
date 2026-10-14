/**
 * The Docker runner's small pieces (2.4): the `deuz.sdk-version` label value
 * kept in step with the package, the bounded output tail, and the
 * container-side path rules behind `cwd` confinement.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCKER_LABEL_SDK_VERSION } from '../src/compute/docker/engine';
import { ByteTail } from '../src/compute/docker/output';
import { isWithinPosix, posixResolve } from '../src/compute/docker/paths';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('deuz.sdk-version label', () => {
  it('names a release no older than the package it ships in', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    const [major, minor] = pkg.version.split('.').map(Number);
    const [labelMajor, labelMinor] = DOCKER_LABEL_SDK_VERSION.split('.').map(Number);
    expect(DOCKER_LABEL_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // Equal after the 2.4.0 version bump; a later minor must update the label.
    expect(labelMajor! * 1000 + labelMinor!).toBeGreaterThanOrEqual(major! * 1000 + minor!);
    expect(labelMajor! * 1000 + labelMinor!).toBeLessThanOrEqual(major! * 1000 + minor! + 1);
  });
});

describe('ByteTail', () => {
  it('keeps the last bytes and says when it dropped any', () => {
    const tail = new ByteTail(5);
    tail.push(bytes('abc'));
    expect([tail.text(), tail.truncated]).toEqual(['abc', false]);
    tail.push(bytes('de'));
    expect([tail.text(), tail.truncated]).toEqual(['abcde', false]);
    tail.push(bytes('f'));
    expect([tail.text(), tail.truncated]).toEqual(['bcdef', true]);
    tail.push(bytes('0123456789'));
    expect([tail.text(), tail.truncated]).toEqual(['56789', true]);
  });

  it('never starts the text in the middle of a character', () => {
    const tail = new ByteTail(4);
    tail.push(bytes('xç😀')); // x, ç (2 bytes), 😀 (4 bytes)
    expect(tail.truncated).toBe(true);
    expect(tail.text()).toBe('😀');
    const exact = new ByteTail(4);
    exact.push(bytes('😀'));
    expect([exact.text(), exact.truncated]).toEqual(['😀', false]);
  });
});

describe('container paths', () => {
  it('resolves relative and absolute paths and tells inside from outside', () => {
    expect(posixResolve('/workspace', 'a/./b/../c')).toBe('/workspace/a/c');
    expect(posixResolve('/workspace', '/etc')).toBe('/etc');
    expect(posixResolve('/workspace', '../..')).toBe('/');
    expect(isWithinPosix('/workspace', '/workspace')).toBe(true);
    expect(isWithinPosix('/workspace', '/workspace/a')).toBe(true);
    expect(isWithinPosix('/workspace', '/workspace-other')).toBe(false);
    expect(isWithinPosix('/workspace', '/')).toBe(false);
  });
});
