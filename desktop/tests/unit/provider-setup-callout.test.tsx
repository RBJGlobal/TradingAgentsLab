// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ProviderSetupCallout from '../../src/components/ProviderSetupCallout';

afterEach(cleanup);

describe('ProviderSetupCallout', () => {
  it('explains the no-provider state and the providers available', () => {
    render(<ProviderSetupCallout />);
    expect(screen.getByText(/Connect an AI model/i)).toBeTruthy();
    expect(screen.getByText(/No LLM provider is set up/i)).toBeTruthy();
    expect(screen.getByText(/Anthropic, OpenRouter, or Google Gemini/i)).toBeTruthy();
  });

  it('deep-links to Settings when the button is clicked', () => {
    window.location.hash = '#analyze';
    render(<ProviderSetupCallout />);
    fireEvent.click(screen.getByTestId('setup-provider-cta'));
    expect(window.location.hash).toBe('#settings');
  });
});
