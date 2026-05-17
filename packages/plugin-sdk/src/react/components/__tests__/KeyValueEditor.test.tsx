import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KeyValueEditor, pairsToObject, objectToPairs, type KeyValuePair } from '../KeyValueEditor';

function Harness({ initial = [] as KeyValuePair[], ...rest }: { initial?: KeyValuePair[] } & Partial<React.ComponentProps<typeof KeyValueEditor>>) {
  const [pairs, setPairs] = useState<KeyValuePair[]>(initial);
  return <KeyValueEditor pairs={pairs} onChange={setPairs} {...rest} />;
}

describe('KeyValueEditor', () => {
  it('renders empty text when no pairs', () => {
    render(<Harness emptyText="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders existing pairs', () => {
    render(<Harness initial={[{ key: 'Foo', value: 'bar' }, { key: 'X-Env', value: 'prod' }]} />);
    const keys = screen.getAllByTestId(/kv-key-/);
    const values = screen.getAllByTestId(/kv-value-/);
    expect(keys).toHaveLength(2);
    expect(values).toHaveLength(2);
    expect((keys[0] as HTMLInputElement).value).toBe('Foo');
    expect((values[0] as HTMLInputElement).value).toBe('bar');
    expect((keys[1] as HTMLInputElement).value).toBe('X-Env');
    expect((values[1] as HTMLInputElement).value).toBe('prod');
  });

  it('adds a new blank row on Add', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('kv-add'));
    expect(screen.getByTestId('kv-key-0')).toBeInTheDocument();
    expect(screen.getByTestId('kv-value-0')).toBeInTheDocument();
  });

  it('edits an existing key/value', () => {
    render(<Harness initial={[{ key: 'A', value: '1' }]} />);
    fireEvent.change(screen.getByTestId('kv-key-0'), { target: { value: 'Authorization' } });
    fireEvent.change(screen.getByTestId('kv-value-0'), { target: { value: 'Bearer abc' } });
    expect((screen.getByTestId('kv-key-0') as HTMLInputElement).value).toBe('Authorization');
    expect((screen.getByTestId('kv-value-0') as HTMLInputElement).value).toBe('Bearer abc');
  });

  it('removes a row', () => {
    render(<Harness initial={[{ key: 'A', value: '1' }, { key: 'B', value: '2' }]} />);
    fireEvent.click(screen.getByTestId('kv-remove-0'));
    const keys = screen.getAllByTestId(/kv-key-/);
    expect(keys).toHaveLength(1);
    expect((keys[0] as HTMLInputElement).value).toBe('B');
  });

  it('uses password input type when valueType=password', () => {
    render(<Harness initial={[{ key: 'A', value: 'secret' }]} valueType="password" />);
    const input = screen.getByTestId('kv-value-0') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('scopes data-testid via testIdPrefix', () => {
    render(<Harness initial={[{ key: 'A', value: '1' }]} testIdPrefix="hdr" />);
    expect(screen.getByTestId('hdr-editor')).toBeInTheDocument();
    expect(screen.getByTestId('hdr-key-0')).toBeInTheDocument();
    expect(screen.getByTestId('hdr-add')).toBeInTheDocument();
  });

  it('disables all inputs when disabled', () => {
    render(<Harness initial={[{ key: 'A', value: '1' }]} disabled />);
    expect((screen.getByTestId('kv-key-0') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('kv-value-0') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('kv-remove-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('kv-add') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('pairsToObject', () => {
  it('converts pairs to object', () => {
    expect(pairsToObject([{ key: 'A', value: '1' }, { key: 'B', value: '2' }])).toEqual({ A: '1', B: '2' });
  });

  it('drops rows with empty keys', () => {
    expect(pairsToObject([{ key: '', value: 'orphan' }, { key: 'A', value: '1' }])).toEqual({ A: '1' });
  });

  it('trims whitespace from keys', () => {
    expect(pairsToObject([{ key: '  Authorization  ', value: 'Bearer x' }])).toEqual({ Authorization: 'Bearer x' });
  });

  it('later keys win on duplicate', () => {
    expect(pairsToObject([{ key: 'A', value: '1' }, { key: 'A', value: '2' }])).toEqual({ A: '2' });
  });
});

describe('objectToPairs', () => {
  it('converts object to pairs preserving order', () => {
    expect(objectToPairs({ A: '1', B: '2' })).toEqual([{ key: 'A', value: '1' }, { key: 'B', value: '2' }]);
  });

  it('handles null/undefined', () => {
    expect(objectToPairs(null)).toEqual([]);
    expect(objectToPairs(undefined)).toEqual([]);
  });

  it('coerces non-string values to strings', () => {
    expect(objectToPairs({ A: 1 as unknown as string })).toEqual([{ key: 'A', value: '1' }]);
  });
});
