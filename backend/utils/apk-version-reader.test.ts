import { describe, it, expect } from 'vitest';
import { parseManifestXml } from './apk-version-reader';

describe('parseManifestXml', () => {
  it('extracts versionCode, versionName, and packageName', () => {
    const xml = `<manifest
  xmlns:android="http://schemas.android.com/apk/res/android"
  package="com.example.myapp"
  android:versionCode="42"
  android:versionName="1.2.3">
  <application android:label="MyApp" />
</manifest>`;
    const result = parseManifestXml(xml);
    expect(result.packageName).toBe('com.example.myapp');
    expect(result.versionCode).toBe(42);
    expect(result.versionName).toBe('1.2.3');
  });

  it('returns null for missing versionCode', () => {
    const xml = `<manifest package="com.example.app" android:versionName="2.0">
</manifest>`;
    const result = parseManifestXml(xml);
    expect(result.packageName).toBe('com.example.app');
    expect(result.versionCode).toBeNull();
    expect(result.versionName).toBe('2.0');
  });

  it('returns null for missing versionName', () => {
    const xml = `<manifest package="com.example.app" android:versionCode="10">
</manifest>`;
    const result = parseManifestXml(xml);
    expect(result.versionCode).toBe(10);
    expect(result.versionName).toBeNull();
  });

  it('returns all nulls for empty XML', () => {
    const result = parseManifestXml('');
    expect(result.packageName).toBeNull();
    expect(result.versionCode).toBeNull();
    expect(result.versionName).toBeNull();
  });

  it('handles multiline attribute format from AXML decoder', () => {
    const xml = `<manifest
  xmlns:android="http://schemas.android.com/apk/res/android"
  package="com.example.app"
  android:versionCode="150"
  android:versionName="3.5.0-beta"
  android:compileSdkVersion="34">
  <uses-sdk
    android:minSdkVersion="24"
    android:targetSdkVersion="34">
  </uses-sdk>
</manifest>`;
    const result = parseManifestXml(xml);
    expect(result.packageName).toBe('com.example.app');
    expect(result.versionCode).toBe(150);
    expect(result.versionName).toBe('3.5.0-beta');
  });

  it('returns null for XML with no manifest attributes', () => {
    const xml = '<manifest></manifest>';
    const result = parseManifestXml(xml);
    expect(result.packageName).toBeNull();
    expect(result.versionCode).toBeNull();
    expect(result.versionName).toBeNull();
  });
});
