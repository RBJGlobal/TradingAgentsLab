import styles from './LearnAI.module.css';

/**
 * Learn AI — an in-app page (not a raw external link) introducing Clawdemy,
 * RBJ Global's free AI education platform, with a single deliberate button to
 * open it. Permanent in-app spot for the educational mission + the family.
 *
 * Content is drawn from clawdemy.org and rbjglobal.com (factual, no claims
 * invented here). The "Open Clawdemy" link opens the browser via main.ts'
 * setWindowOpenHandler (http(s) only).
 */
const CLAWDEMY_URL = 'https://clawdemy.org';

export default function LearnAI() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Learn AI</h1>
      <p className={styles.lede}>
        Trading Agents Lab is one of a family of free, privacy-first tools from
        RBJ Global. If you want to understand the AI behind it, and AI in
        general, our education platform <strong>Clawdemy</strong> is free and
        open to everyone.
      </p>

      <section className={styles.card}>
        <h2 className={styles.h2}>What Clawdemy is</h2>
        <p>
          A free AI literacy platform built on one idea:{' '}
          <em>understand AI well enough to use it, not be used by it.</em> The
          curriculum runs 24 tracks and 310 lessons, from foundational
          mathematics through neural networks, transformers, and large language
          models, all the way to building your own LLMs and autonomous agents.
          Every lesson cites its sources so you can verify what you learn.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Read it or listen to it</h2>
        <p>
          Every lesson comes as written text and as AI-narrated audio with the
          text highlighted as it plays, so you can read at your desk or listen
          on the move. Lessons also include hand-drawn diagrams, interactive
          flashcards, and worked exercises.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Why it is free</h2>
        <p>
          No account, no email, no paywall, no ads, no upsells, no tracking. The
          mission is simply to make AI education accessible to everyone, on the
          belief that the best tools remove barriers rather than create them.
          It is made for the worried generalist as much as the curious
          developer, and it is used by individual learners, educators, schools,
          and non-profits.
        </p>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Who is behind it</h2>
        <p>
          Clawdemy and Trading Agents Lab are both built by Junaid (Jay)
          Siddiqi, principal of RBJ Global, an independently operated studio in
          Dallas. RBJ Global is a portfolio of independent, privacy-first
          software, built and operated by a single principal working with AI
          agents: a free AI education platform (Clawdemy), open-source tools,
          and apps like this one. The free education and the free, open tools
          come from the same mission.
        </p>
        <p className={styles.connect}>
          Want to connect with the founder or follow the work?{' '}
          <a
            href="https://www.linkedin.com/in/junaidsiddiqi/"
            target="_blank"
            rel="noreferrer"
          >
            Find Jay Siddiqi on LinkedIn
          </a>
          .
        </p>
      </section>

      <div className={styles.ctaRow}>
        <a
          className={styles.cta}
          href={CLAWDEMY_URL}
          target="_blank"
          rel="noreferrer"
        >
          Open Clawdemy (free)
        </a>
        <span className={styles.ctaHint}>
          Opens clawdemy.org in your browser. Free, no signup.
        </span>
      </div>

      <p className={styles.footnote}>
        Clawdemy is an educational resource. Like Trading Agents Lab, it is for
        learning, not investment advice.
      </p>
    </div>
  );
}
