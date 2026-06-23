import styles from './ProviderSetupCallout.module.css';

/**
 * Shown on Analyze when no LLM provider is configured (activeProvider === null).
 * New users otherwise have no idea the app is running a built-in sample instead
 * of the real multi-agent analysis, and no signpost to Settings. This is an
 * informational callout (not a blocking wizard); it auto-hides once a provider
 * is added. The button deep-links to Settings (LLM Providers is the default tab).
 */
export default function ProviderSetupCallout() {
  return (
    <div className={styles.callout} role="status">
      <div className={styles.body}>
        <h2 className={styles.title}>Connect an AI model to run the real analysis</h2>
        <p className={styles.text}>
          No LLM provider is set up yet, so the Diligence runs a built-in sample
          rather than a real multi-agent analysis. Add a provider to unlock the
          full thing. OpenAI works free with your ChatGPT plan (OAuth
          recommended), or paste an API key for OpenAI, Anthropic, OpenRouter,
          or Google Gemini.
        </p>
      </div>
      <button
        type="button"
        className={styles.cta}
        onClick={() => {
          window.location.hash = '#settings';
        }}
        data-testid="setup-provider-cta"
      >
        Set up a provider
      </button>
    </div>
  );
}
