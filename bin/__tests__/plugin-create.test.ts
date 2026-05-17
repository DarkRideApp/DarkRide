import { describe, it, expect } from 'vitest';
import { renderTemplate, toSlug, toPascalCase, toLabel } from '../commands/plugin-create';

describe('plugin create helpers', () => {
  it('converts name to slug', () => {
    expect(toSlug('My Cool Plugin')).toBe('my-cool-plugin');
    expect(toSlug('test')).toBe('test');
    expect(toSlug('  HELLO World  ')).toBe('hello-world');
  });

  it('converts slug to PascalCase', () => {
    expect(toPascalCase('my-cool-plugin')).toBe('MyCoolPlugin');
    expect(toPascalCase('test')).toBe('Test');
  });

  it('converts slug to label', () => {
    expect(toLabel('my-cool-plugin')).toBe('My Cool Plugin');
    expect(toLabel('test')).toBe('Test');
  });

  it('renders template with placeholders', () => {
    const template = 'Hello {{name}}, your plugin is {{slug}}!';
    const result = renderTemplate(template, { name: 'World', slug: 'my-plugin' });
    expect(result).toBe('Hello World, your plugin is my-plugin!');
  });

  it('replaces all occurrences of a placeholder', () => {
    const template = '{{slug}} and {{slug}} again';
    const result = renderTemplate(template, { slug: 'test' });
    expect(result).toBe('test and test again');
  });
});
