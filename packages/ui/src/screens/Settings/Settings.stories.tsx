/**
 * Screens/Settings — one story per STATE against `MockNetworkAdapter` (execution plan §0
 * rule 8). The screenshot script writes these to artifacts/screens/settings/.
 * `MockNetworkAdapter` is allowed here and in tests only, never in the screen source.
 *
 * Two stories drive the DOM after mount (an invalid relay typed + submitted; a failed save)
 * so the inline-error and rollback + toast states can be screenshotted without a play step.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type {
  NetworkAdapter,
  Profile,
  SeederStatus,
  Settings as SettingsData,
  SignerStatus,
} from '@sovit/core';
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { ME, MINTS, avatar, sats } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Settings, type SettingsProps } from './Settings.js';
import './Settings.css';

const { MockNetworkAdapter } = mocks;
type Options = ConstructorParameters<typeof MockNetworkAdapter>[0];

const MY_PICTURE = 'https://fixture.example/avatars/me.png';

/** The stock mock, with a profile picture for the viewer that `image()` answers offline. */
function storyAdapter(opts: Options = {}, patch: Partial<SettingsData> = {}): NetworkAdapter {
  const a = new MockNetworkAdapter(opts);
  // The mock applies a patch synchronously (then delays the answer), so this is set up-front.
  void a.updateSettings({ theme: 'system', ...patch }).catch(() => undefined);
  const profile = a.profile.bind(a);
  a.profile = async (pk): Promise<Profile | null> => {
    const p = await profile(pk);
    return pk === ME && p ? { ...p, picture: MY_PICTURE } : p;
  };
  const image = a.image.bind(a);
  a.image = (url, sha256) => image(url === MY_PICTURE ? avatar(ME) : url, sha256);
  return a;
}

/** Same adapter with some methods replaced (signer variants, failing writes, …). */
function override(
  base: NetworkAdapter,
  methods: Partial<Record<keyof NetworkAdapter, unknown>>,
  seeder: Partial<NetworkAdapter['seeder']> = {},
): NetworkAdapter {
  const seederProxy = { ...base.seeder, ...seeder };
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'seeder') return seederProxy;
      if (typeof prop === 'string' && prop in methods)
        return (methods as Record<string, unknown>)[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function signerAs(base: NetworkAdapter, status: SignerStatus): NetworkAdapter {
  return override(base, { signer: () => Promise.resolve(status) });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(
  props: Partial<SettingsProps> & { readonly adapter: NetworkAdapter },
): ReactElement {
  return <Settings navigate={navigate} inlineToasts {...props} />;
}

/** Story-only: waits for `selector` inside the story, then runs `act` on it once. */
function Drive({
  selector,
  act,
  children,
}: {
  readonly selector: string;
  readonly act: (el: HTMLElement, root: HTMLElement) => void;
  readonly children: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      const root = ref.current;
      const el = root?.querySelector<HTMLElement>(selector);
      if (root && el) {
        clearInterval(t);
        act(el, root);
      } else if (tries > 100) clearInterval(t);
    }, 10);
    return () => {
      clearInterval(t);
    };
  }, [act, selector]);
  return <div ref={ref}>{children}</div>;
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const meta = {
  title: 'Screens/Settings',
  component: Settings,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Settings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  name: 'Loading (skeletons)',
  render: () => <Screen adapter={storyAdapter({ latencyMs: 5000 })} />,
};

export const Populated: Story = {
  name: 'Populated (local key, follows device theme)',
  render: () => <Screen adapter={storyAdapter()} />,
};

export const AutoTopUpOn: Story = {
  name: 'Auto top-up on, dark theme chosen',
  render: () => (
    <Screen
      adapter={storyAdapter(
        {},
        {
          theme: 'dark',
          autoTopUp: { belowSats: sats(2_500), fromMint: MINTS.a },
        },
      )}
    />
  ),
};

export const SeedingOff: Story = {
  name: 'Seeding off, data saver buffer',
  render: () => (
    <Screen
      adapter={storyAdapter({ seeding: false }, { prefetchSeconds: 10, hoverPreview: false })}
    />
  ),
};

export const Empty: Story = {
  name: 'Empty — no relays, no default mints',
  render: () => <Screen adapter={storyAdapter({}, { relays: [], defaultMints: [] })} />,
};

export const RemoteSigner: Story = {
  name: 'Signer — remote (NIP-46), wallet key fallback',
  render: () => (
    <Screen
      adapter={signerAs(storyAdapter(), {
        kind: 'nip46',
        pubkey: ME,
        locked: false,
        supportsSignSecret: false,
        detail: 'wss://bunker.fixture.example · remote 7e1f09c2…a41b',
      })}
    />
  ),
};

export const SignerLocked: Story = {
  name: 'Signer — local key, locked',
  render: () => (
    <Screen
      adapter={signerAs(storyAdapter(), {
        kind: 'local',
        pubkey: ME,
        locked: true,
        supportsSignSecret: true,
      })}
    />
  ),
};

export const SignerSwitchable: Story = {
  name: 'Signer — switchable (shell provides onChangeSigner)',
  render: () => (
    <Screen
      adapter={storyAdapter()}
      onChangeSigner={(kind) => {
        console.warn('change signer', kind);
      }}
    />
  ),
};

export const SignedOut: Story = {
  name: 'Signed out',
  render: () => <Screen adapter={storyAdapter({ signedIn: false })} />,
};

export const NoSigner: Story = {
  name: 'Error — no signer',
  render: () => (
    <Screen
      adapter={storyAdapter({ failWith: 'no-signer' })}
      onChangeSigner={(kind) => {
        console.warn('connect signer', kind);
      }}
    />
  ),
};

export const NoBalance: Story = {
  name: 'Error — no balance (0 sats at every mint)',
  render: () => (
    <Screen
      adapter={storyAdapter(
        { failWith: 'no-balance' },
        { autoTopUp: { belowSats: sats(1_000), fromMint: MINTS.a } },
      )}
    />
  ),
};

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={storyAdapter({ failWith: 'relay-down' })} />,
};

export const SignerUnreachable: Story = {
  name: 'Error — signer and seeder unreachable',
  render: () => (
    <Screen
      adapter={override(
        storyAdapter(),
        { signer: () => Promise.reject(new Error('nip46: bunker did not answer within 10 s')) },
        {
          status: (): Promise<SeederStatus> => Promise.reject(new Error('seeder worker stopped')),
        },
      )}
    />
  ),
};

export const SaveFailed: Story = {
  name: 'Error — save failed (rolled back, input kept, toast)',
  render: () => {
    const adapter = override(storyAdapter(), {
      updateSettings: () => Promise.reject(new Error('relay-down: no relays reachable')),
    });
    return (
      <Drive
        selector='input[role="switch"][id$="-hover"]'
        act={(hover, root) => {
          hover.click();
          const cap = root.querySelector<HTMLInputElement>('input[id$="-seeding-cap"]');
          if (cap) {
            cap.focus({ preventScroll: true });
            typeInto(cap, '20');
            cap.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        }}
      >
        <Screen adapter={adapter} />
      </Drive>
    );
  },
};

export const InvalidRelay: Story = {
  name: 'Invalid relay address (ws:// rejected inline)',
  render: () => (
    <Drive
      selector='input[id$="-relays-add"]'
      act={(el) => {
        const input = el as HTMLInputElement;
        typeInto(input, 'ws://relay.example');
        input.form?.requestSubmit();
      }}
    >
      <Screen adapter={storyAdapter()} />
    </Drive>
  ),
};

export const Narrow: Story = {
  name: 'Narrow (mobile width)',
  parameters: { nf: { width: 400 } },
  render: () => <Screen adapter={storyAdapter()} />,
};
