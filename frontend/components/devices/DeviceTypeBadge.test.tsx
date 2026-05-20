import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DeviceTypeBadge } from './DeviceTypeBadge';

describe('DeviceTypeBadge', () => {
  it('renders "physical" for adb-device', () => {
    render(<DeviceTypeBadge providerId="adb-device" />);
    expect(screen.getByText(/physical/i)).toBeInTheDocument();
  });

  it('renders "avd" for the avd provider', () => {
    render(<DeviceTypeBadge providerId="avd" />);
    expect(screen.getByText('avd')).toBeInTheDocument();
  });

  it('renders "docker" for the docker-android provider', () => {
    render(<DeviceTypeBadge providerId="docker-android" />);
    expect(screen.getByText('docker')).toBeInTheDocument();
  });

  it('renders "ios" for the ios-device provider', () => {
    render(<DeviceTypeBadge providerId="ios-device" />);
    expect(screen.getByText('ios')).toBeInTheDocument();
  });

  it('falls back to providerId for unknown providers (plugin lane)', () => {
    render(<DeviceTypeBadge providerId="corellium-cloud" />);
    expect(screen.getByText('corellium-cloud')).toBeInTheDocument();
  });
});
