import copilotStudioIcon from '../../assets/icons/copilot-studio.png';
import geminiIcon from '../../assets/icons/google-gemini-icon.webp';
import microsoftIcon from '../../assets/icons/Microsoft.svg';
import googleIcon from '../../assets/icons/googleg_gradient_standard_48px.svg';

/**
 * The four product marks that say WHICH SIDE a column is.
 *
 * Every screen in this wizard puts a Microsoft thing beside a Google thing, and
 * on three of them the two sides read identically: Select agents shows the same
 * text in "Source name" and "Destination name" (the destination defaults to the
 * source), Map users shows one person's two accounts, and Env pairing points an
 * environment at an app. Column headings alone did not survive that -- with the
 * same string twice, nothing on the row itself said which half was which.
 *
 * One module, not an import in each page, because the asset path is the fact
 * that drifts: a logo swapped in one screen and not the others is the exact
 * "same fact, two implementations" bug this codebase keeps paying for.
 *
 * AGENTS vs PEOPLE is a real distinction, not decoration. An agent is authored
 * in Copilot Studio and lands in Gemini, so those rows take the product marks.
 * A person is a Microsoft 365 account mapped to a Google Workspace account --
 * no agent product is involved, and stamping Copilot Studio on a human would
 * say something false. Those rows take the plain vendor marks.
 *
 * All four are decorative: a visible heading or the row's own text always names
 * the same thing, so they are hidden from screen readers rather than read out
 * twice.
 */
function Mark({ src, size }: { src: string; size: number }) {
  return (
    <img
      className="v2-pmark"
      src={src}
      alt=""
      aria-hidden="true"
      style={{ width: size, height: size }}
    />
  );
}

/** Microsoft Copilot Studio — the source product for AGENTS. */
export function CopilotStudioMark({ s = 16 }: { s?: number }) {
  return <Mark src={copilotStudioIcon} size={s} />;
}

/** Google Gemini — the destination product for AGENTS. */
export function GeminiMark({ s = 16 }: { s?: number }) {
  return <Mark src={geminiIcon} size={s} />;
}

/** Microsoft — the source vendor for PEOPLE (a Microsoft 365 account). */
export function MicrosoftMark({ s = 14 }: { s?: number }) {
  return <Mark src={microsoftIcon} size={s} />;
}

/** Google — the destination vendor for PEOPLE (a Google Workspace account). */
export function GoogleMark({ s = 14 }: { s?: number }) {
  return <Mark src={googleIcon} size={s} />;
}
