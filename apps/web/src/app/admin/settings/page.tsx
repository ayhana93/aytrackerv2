'use client';

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  AdminBody,
  AdminHeader,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Grid,
  UNBRANDED,
  ThemeToggle,
  brandAccentVariables,
  contrastRatio,
  gradeContrast,
  useTheme,
  type ContrastGrade,
} from '@aytracker/ui';

/**
 * White-label settings.
 *
 * A customer picks their colour, their name and their logo, and sees the result before they save.
 *
 * The rule this screen enforces is the one that makes white-labelling safe: **a brand reaches the
 * accent family and nothing else.** Surfaces, text and state colours stay ours. Without that
 * boundary a customer can pick a colour that makes their own workers' interface unreadable, and
 * the first anyone hears about it is a worker who cannot find the button to end their shift.
 *
 * So the contrast is computed from the customer's actual colour and shown to them here — not
 * assumed, and not checked only on save. The verdict is reported in three states rather than a
 * pass/fail, because a colour at 3.5:1 is genuinely fine for a heading and genuinely not fine for
 * body text, and collapsing that into one badge would mislead whichever way it went.
 *
 * The preview applies `brandAccentVariables` — the exact function the runtime uses — rather than
 * a hand-written approximation. Otherwise the preview and the product drift, and the person who
 * finds out is the customer who approved one look and shipped another.
 */

const PRESETS = ['#2563EB', '#0F766E', '#B91C1C', '#7C3AED', '#C2410C', '#0F172A'] as const;

export default function BrandingSettingsPage() {
  const [companyName, setCompanyName] = useState('Демо Завод ООД');
  const [primary, setPrimary] = useState<string>('#2563EB');
  const [loginMessage, setLoginMessage] = useState('Добре дошли! Въведете вашия служебен номер.');
  const [customDomain, setCustomDomain] = useState('');

  const { mode } = useTheme();

  /**
   * Measured against both theme surfaces, because the brand colour is applied unchanged in both.
   * A colour chosen in light mode is the same colour a night-shift worker sees on near-black.
   */
  const contrast = useMemo(
    () => ({
      light: { ratio: contrastRatio(primary, '#FFFFFF'), grade: gradeContrast(primary, '#FFFFFF') },
      dark: { ratio: contrastRatio(primary, '#0F1623'), grade: gradeContrast(primary, '#0F1623') },
    }),
    [primary],
  );

  const worst: ContrastGrade =
    contrast.light.grade === 'FAIL' || contrast.dark.grade === 'FAIL'
      ? 'FAIL'
      : contrast.light.grade === 'AA_LARGE' || contrast.dark.grade === 'AA_LARGE'
        ? 'AA_LARGE'
        : 'AA';

  // The real runtime mapping, scoped to the preview subtree.
  const previewVariables = useMemo(
    () =>
      brandAccentVariables(
        { ...UNBRANDED, colors: { ...UNBRANDED.colors, primary } },
        mode,
      ) as CSSProperties,
    [primary, mode],
  );

  return (
    <>
      <AdminHeader
        title="Брандиране"
        subtitle="Как изглежда AYtracker за вашите служители"
        actions={
          <>
            <ThemeToggle labels={{ light: 'Светла', dark: 'Тъмна', system: 'Системна' }} />
            <Button>Запази</Button>
          </>
        }
      />

      <AdminBody>
        <Grid wide>
          <Card padded={false}>
            <CardHeader>
              <h2 className="ay-h3">Идентичност</h2>
            </CardHeader>
            <div
              style={{
                padding: 'var(--ay-space-5)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--ay-space-5)',
              }}
            >
              <Field label="Име на компанията" hint="Показва се на екрана за вход и в отчетите.">
                <input
                  className="ay-input"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                />
              </Field>

              <Field
                label="Основен цвят"
                hint="Прилага се само върху акцентите — бутони, връзки, активни състояния."
              >
                <div className="ay-swatch-row">
                  <input
                    type="color"
                    className="ay-swatch"
                    value={primary}
                    onChange={(event) => setPrimary(event.target.value)}
                    aria-label="Избор на основен цвят"
                  />
                  <input
                    className="ay-input"
                    style={{ flex: 1 }}
                    value={primary.toUpperCase()}
                    onChange={(event) => setPrimary(event.target.value)}
                    aria-label="Основен цвят, шестнадесетичен код"
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 'var(--ay-space-2)',
                    marginTop: 'var(--ay-space-2)',
                  }}
                >
                  {PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="ay-swatch"
                      style={{ background: preset, width: '2rem', height: '2rem' }}
                      onClick={() => setPrimary(preset)}
                      aria-label={`Използвай ${preset}`}
                    />
                  ))}
                </div>
              </Field>

              <Field label="Съобщение при вход" hint="По желание. Виждат го само вашите служители.">
                <input
                  className="ay-input"
                  value={loginMessage}
                  onChange={(event) => setLoginMessage(event.target.value)}
                />
              </Field>

              <Field
                label="Собствен домейн"
                hint="Например tracker.vashata-firma.bg. Изисква CNAME запис и се проверява преди активиране."
              >
                <input
                  className="ay-input"
                  placeholder="tracker.vashata-firma.bg"
                  value={customDomain}
                  onChange={(event) => setCustomDomain(event.target.value)}
                />
              </Field>
            </div>
          </Card>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ay-space-4)' }}>
            <Card padded={false}>
              <CardHeader>
                <h2 className="ay-h3">Проверка на четимостта</h2>
                <Badge tone={GRADE_TONE[worst]}>{GRADE_LABEL[worst]}</Badge>
              </CardHeader>
              <div
                style={{
                  padding: 'var(--ay-space-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--ay-space-4)',
                }}
              >
                <ContrastRow
                  label="Върху светъл фон"
                  ratio={contrast.light.ratio}
                  grade={contrast.light.grade}
                />
                <ContrastRow
                  label="Върху тъмен фон"
                  ratio={contrast.dark.ratio}
                  grade={contrast.dark.grade}
                />
                <p className="ay-caption ay-muted">{GRADE_EXPLANATION[worst]}</p>
              </div>
            </Card>

            {/*
              The preview renders the real primitives with the customer's colour scoped to this
              subtree, rather than a picture of them. A mock-up would be a promise; this is the
              thing itself, so what they approve is what their workers get.
            */}
            <Card padded={false}>
              <CardHeader>
                <h2 className="ay-h3">Преглед</h2>
              </CardHeader>
              <div
                style={{
                  padding: 'var(--ay-space-5)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--ay-space-4)',
                  ...previewVariables,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}>
                  <span className="ay-sidebar-mark" aria-hidden="true">
                    {companyName.trim().charAt(0).toUpperCase() || 'A'}
                  </span>
                  <div>
                    <p style={{ fontWeight: 650 }}>{companyName || 'Вашата компания'}</p>
                    <p className="ay-caption ay-muted">{loginMessage}</p>
                  </div>
                </div>
                <Button block size="large">
                  Започни смяна
                </Button>
                <div style={{ display: 'flex', gap: 'var(--ay-space-2)' }}>
                  <Badge tone="accent">Активна позиция</Badge>
                  <Badge tone="success">Работи</Badge>
                </div>
              </div>
            </Card>

            <Card>
              <p className="ay-small" style={{ fontWeight: 550 }}>
                Какво не се променя
              </p>
              <p className="ay-caption ay-muted" style={{ marginTop: 'var(--ay-space-2)' }}>
                Фонове, текст и цветовете за състояние (работи, почивка, предупреждение) остават
                непроменени. Така избран цвят никога не може да направи интерфейса нечетим за вашите
                служители.
              </p>
            </Card>
          </div>
        </Grid>
      </AdminBody>
    </>
  );
}

const GRADE_LABEL: Readonly<Record<ContrastGrade, string>> = {
  AA: 'AA — всякакъв текст',
  AA_LARGE: 'AA — само едър текст',
  FAIL: 'Под AA',
};

const GRADE_TONE: Readonly<Record<ContrastGrade, 'success' | 'warning' | 'danger'>> = {
  AA: 'success',
  AA_LARGE: 'warning',
  FAIL: 'danger',
};

const GRADE_EXPLANATION: Readonly<Record<ContrastGrade, string>> = {
  AA: 'Този цвят е четим като текст и в двете теми.',
  AA_LARGE:
    'Достатъчен за заглавия и бутони, но нечетим като дребен текст в поне една от темите. Текстът върху цвета ще използва автоматично избран контрастен цвят.',
  FAIL: 'Този цвят не е четим като текст. Ще се използва само като фон, с автоматично избран контрастен текст върху него. Основните повърхности и текст остават непроменени.',
};

function ContrastRow({
  label,
  ratio,
  grade,
}: {
  label: string;
  ratio: number;
  grade: ContrastGrade;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span className="ay-small">{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--ay-space-3)' }}>
        <span className="ay-small ay-numeric ay-muted">{ratio.toFixed(2)}:1</span>
        <Badge tone={GRADE_TONE[grade]}>{GRADE_LABEL[grade]}</Badge>
      </span>
    </div>
  );
}
