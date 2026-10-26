import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ProjectSetupModal } from "@/components/ProjectSetupModal";
import { ProviderSettings } from "@/types";

vi.mock('@/components/settings/EnvironmentImport', () => ({
  EnvironmentImport: ({ onImported }: { onImported: (value: unknown) => void }) => <button onClick={() => onImported({ preferences: {} })}>Complete environment import</button>,
}));

// The Library page talks to the asset library; its own tests cover it.
vi.mock("@/components/settings/LibrarySettingsTab", () => ({
  LibrarySettingsTab: () => <div data-testid="library-settings">Library settings</div>,
}));

// Mock the workflow store
const mockSetUseExternalImageStorage = vi.fn();
const mockUpdateProviderApiKey = vi.fn();
const mockToggleProvider = vi.fn();
const mockUseWorkflowStore = vi.fn();

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    { getState: () => mockUseWorkflowStore((s: unknown) => s) }
  ),
  generateWorkflowId: () => "mock-workflow-id",
}));

// What the asset library last said about itself (null until it has answered)
const mockLibraryStatus = vi.fn((): { available: boolean; root: string | null } | null => null);
vi.mock("@/lib/assets/client/recorder", () => ({
  getRecorderLibraryStatus: () => mockLibraryStatus(),
}));

// Stand-in for the model browser: a search box rendered, like the real one,
// as a React child of the settings dialog's panel.
vi.mock("@/components/modals/ModelSearchDialog", () => ({
  ModelSearchDialog: ({ onModelSelected }: { onModelSelected?: (m: unknown) => void }) => (
    <div data-testid="model-search-dialog">
      <input placeholder="Search models..." />
      <button
        type="button"
        onClick={() => onModelSelected?.({ provider: "fal", id: "fal/test-model", name: "Test Model" })}
      >
        Test Model
      </button>
    </div>
  ),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock confirm
const mockConfirm = vi.fn(() => true);
global.confirm = mockConfirm;

// Ensure localStorage is always available in this test environment
const localStorageMock = {
  getItem: vi.fn((_key?: string): string | null => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(() => null),
  length: 0,
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

// Default provider settings
const defaultProviderSettings: ProviderSettings = {
  providers: {
    gemini: { id: "gemini", name: "Gemini", enabled: true, apiKey: null, apiKeyEnvVar: "GEMINI_API_KEY" },
    openai: { id: "openai", name: "OpenAI", enabled: false, apiKey: null },
    replicate: { id: "replicate", name: "Replicate", enabled: false, apiKey: null },
    fal: { id: "fal", name: "fal.ai", enabled: false, apiKey: null },
    kie: { id: "kie", name: "Kie.ai", enabled: false, apiKey: null },
    wavespeed: { id: "wavespeed", name: "WaveSpeed", enabled: false, apiKey: null },
    comfy: { id: "comfy", name: "ComfyUI", enabled: false, apiKey: null },
  },
};

// Default store state factory
const createDefaultState = (overrides = {}) => ({
  workflowName: "",
  workflowId: "",
  saveDirectoryPath: "",
  useExternalImageStorage: true,
  providerSettings: defaultProviderSettings,
  setUseExternalImageStorage: mockSetUseExternalImageStorage,
  updateProviderApiKey: mockUpdateProviderApiKey,
  toggleProvider: mockToggleProvider,
  edgeStyle: "curved",
  edgeAppearance: { thickness: "regular", fadedOpacity: 0.25, gradient: true, loadingPulse: true },
  setEdgeStyle: vi.fn(),
  setEdgeAppearance: vi.fn(),
  ...overrides,
});

describe("ProjectSetupModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.getItem.mockImplementation(() => null);
    // Default mock for env-status API (called on modal open)
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/env-status") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
        });
      }
      // Default success response for other APIs
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });
    mockUseWorkflowStore.mockImplementation((selector) => {
      return selector(createDefaultState());
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a provider key explicitly cleared before an unrelated environment import', async () => {
    const settings = { providers: { ...defaultProviderSettings.providers, gemini: { ...defaultProviderSettings.providers.gemini, apiKey: 'saved-gemini-key' } } };
    mockUseWorkflowStore.mockImplementation(selector => selector(createDefaultState({ providerSettings: settings })));
    localStorageMock.getItem.mockImplementation((key?: string) => key === 'node-banana-provider-settings' ? JSON.stringify({ providers: {
      ...settings.providers, openai: { ...settings.providers.openai, apiKey: 'imported-openai-key' },
    } }) : null);
    render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={vi.fn()} mode="settings" />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    const key = await screen.findByPlaceholderText('AIza...');
    expect(key).toHaveValue('saved-gemini-key');
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete environment import' }));
    expect(key).toHaveValue('');
    expect(screen.getByPlaceholderText('sk-...')).toHaveValue('imported-openai-key');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockUpdateProviderApiKey).toHaveBeenCalledWith('gemini', null);
    expect(mockUpdateProviderApiKey).toHaveBeenCalledWith('openai', 'imported-openai-key');
    localStorageMock.getItem.mockImplementation(() => null);
  });

  describe("Visibility", () => {
    it("should not render when isOpen is false", () => {
      render(
        <ProjectSetupModal
          isOpen={false}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.queryByText("New project")).not.toBeInTheDocument();
      expect(screen.queryByText("Project settings")).not.toBeInTheDocument();
    });

    it("should render with 'New project' title when mode is 'new'", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("New project")).toBeInTheDocument();
    });

    it("should render with 'Project settings' title when mode is 'settings'", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      expect(screen.getByText("Project settings")).toBeInTheDocument();
    });
  });

  describe("Tab Navigation", () => {
    it("should render Project and Providers tabs", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByRole("button", { name: "Project" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Providers" })).toBeInTheDocument();
    });

    it("should start on Project tab in new mode", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Project tab should show project name input
      expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    });

    it("should switch to Providers tab when clicked", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      // Should show provider names
      expect(screen.getByText("Google Gemini")).toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
      expect(screen.getByText("Replicate")).toBeInTheDocument();
      expect(screen.getByText("fal.ai")).toBeInTheDocument();
    });

    it("opens on the page named by initialTab in settings mode", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
          initialTab="providers"
        />
      );

      expect(screen.getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByText("Google Gemini")).toBeInTheDocument();
    });

    it("ignores initialTab for a new project, which starts on Project", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
          initialTab="providers"
        />
      );

      expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    });
  });

  describe("Project Tab - New Mode", () => {
    it("should render empty form for new project", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;

      expect(nameInput.value).toBe("");
      expect(directoryInput.value).toBe("");
    });

    it("should render Create button in new mode", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Create")).toBeInTheDocument();
    });

    it("should render project name and directory inputs", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Project name")).toBeInTheDocument();
      expect(screen.getByText("Project directory")).toBeInTheDocument();
    });

    it("should render Browse button for directory selection", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Browse")).toBeInTheDocument();
    });

    it("should render embed images checkbox", () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      expect(screen.getByText("Embed images as base64")).toBeInTheDocument();
    });
  });

  describe("Project Tab - Settings Mode", () => {
    it("should pre-fill form with existing values in settings mode", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Existing Project",
          saveDirectoryPath: "/path/to/project",
          useExternalImageStorage: false,
        }));
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      const nameInput = screen.getByPlaceholderText("my-project") as HTMLInputElement;
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;

      expect(nameInput.value).toBe("My Existing Project");
      expect(directoryInput.value).toBe("/path/to/project");
    });

    it("should render Save button in settings mode", () => {
      mockUseWorkflowStore.mockImplementation((selector) => {
        return selector(createDefaultState({
          workflowName: "My Project",
          saveDirectoryPath: "/path/to/project",
        }));
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  describe("Form Validation", () => {
    it("should show error when project name is empty", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill directory but not name
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project");
      fireEvent.change(directoryInput, { target: { value: "/path/to/project" } });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project name is required")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });

    it("should show error when project directory is empty", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill name but not directory
      const nameInput = screen.getByPlaceholderText("my-project");
      fireEvent.change(nameInput, { target: { value: "My Project" } });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project directory is required")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });

    it("should allow save when directory does not exist yet", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/nonexistent/path" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "My Project",
          "/nonexistent/path/My Project"
        );
      });
    });

    it("should show error when path is not absolute", async () => {
      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill name and a hostname-prefixed relative path
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "AT-ALGKG9VR/Users/guy/Desktop/AI Project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(
          screen.getByText("Project directory must be an absolute path (starting with /, a drive letter, or a UNC path)")
        ).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
      // Validation should fail client-side without making a fetch to /api/workflow
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/api/workflow")
      );
    });

    it("should show error when path is not a directory", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/file.txt" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(screen.getByText("Project path is not a directory")).toBeInTheDocument();
      });
      expect(onSave).not.toHaveBeenCalled();
    });
  });

  describe("Save Behavior", () => {
    it("should call onSave with project details when form is valid", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My New Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "My New Project",
          "/path/to/project/My New Project"
        );
      });
    });

    it("should show 'Validating...' while validating directory", async () => {
      let resolveValidation: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return new Promise((resolve) => {
            resolveValidation = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Fill both fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      expect(screen.getByText("Validating...")).toBeInTheDocument();

      // Resolve the validation
      resolveValidation!({
        ok: true,
        json: () => Promise.resolve({ exists: true, isDirectory: true }),
      });
    });

    it("should update external storage setting when saved", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Fill fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      // Toggle the embed switch (click it to enable embed/disable external)
      const embedSwitch = screen.getByRole("switch", { name: /embed images as base64/i });
      fireEvent.click(embedSwitch);

      // Click Create
      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(mockSetUseExternalImageStorage).toHaveBeenCalledWith(false);
      });
    });
  });

  describe("Workflow identity and existing folders", () => {
    /** Folders on "disk": path → the workflow saved there (null = empty folder). */
    function mockFolders(folders: Record<string, { id?: string; name: string } | null>) {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }
        if (url.startsWith("/api/workflow?")) {
          const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
          const folder = params.get("path") ?? "";
          const exists = folder in folders;
          if (params.get("load") === "true") {
            const workflow = folders[folder];
            return Promise.resolve({
              ok: !!workflow,
              json: () => Promise.resolve(workflow ? { success: true, workflow: { version: 1, nodes: [], edges: [], ...workflow } } : { success: false }),
            });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, exists, isDirectory: exists }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });
    }

    function fillAndCreate(projectName: string, directory: string) {
      fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: projectName } });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), { target: { value: directory } });
      fireEvent.click(screen.getByText("Create"));
    }

    it("keeps the id of a canvas that has never had a folder, so its generations join the project", async () => {
      mockFolders({});
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ workflowId: "wf_canvas", saveDirectoryPath: null })));
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);

      fillAndCreate("Fox", "/projects");

      await waitFor(() => expect(onSave).toHaveBeenCalledWith("wf_canvas", "Fox", "/projects/Fox"));
    });

    it("gives a canvas that already has a folder a new id", async () => {
      mockFolders({});
      mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState({ workflowId: "wf_canvas", saveDirectoryPath: "/projects/Old" })));
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);

      fillAndCreate("Fox", "/projects");

      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Fox", "/projects/Fox"));
    });

    it("asks before saving over a different workflow, and replaces it when told to", async () => {
      mockFolders({ "/projects/Fox": { id: "wf_someone_else", name: "Their Fox" } });
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);

      fillAndCreate("Fox", "/projects");

      expect(await screen.findByText("Folder already has a workflow")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent("“Their Fox” is saved in /projects/Fox");
      expect(onSave).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText("Replace"));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Fox", "/projects/Fox"));
    });

    it("saves as '<name> 2' in a folder of its own, leaving the other workflow alone", async () => {
      mockFolders({ "/projects/Fox": { id: "wf_someone_else", name: "Their Fox" } });
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);

      fillAndCreate("Fox", "/projects");
      fireEvent.click(await screen.findByText("Save as “Fox 2”"));

      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Fox 2", "/projects/Fox 2"));
      expect(screen.getByPlaceholderText("my-project")).toHaveValue("Fox 2");
    });

    it("saves over its own workflow without asking", async () => {
      mockFolders({ "/projects/Fox": { id: "wf_mine", name: "Fox" } });
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ workflowId: "wf_mine", workflowName: "Fox", saveDirectoryPath: "/projects/Fox" }))
      );
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="settings" />);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(onSave).toHaveBeenCalledWith("wf_mine", "Fox", "/projects/Fox"));
      expect(screen.queryByText("Folder already has a workflow")).toBeNull();
    });

    it("saves into the folder it already lives in without asking, even when its file has no id", async () => {
      mockFolders({ "/projects/Fox": { name: "Fox" } });
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ workflowId: null, workflowName: "Fox", saveDirectoryPath: "/projects/Fox" }))
      );
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="settings" />);

      fireEvent.click(screen.getByText("Save"));

      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Fox", "/projects/Fox"));
      expect(screen.queryByText("Folder already has a workflow")).toBeNull();
    });
  });

  describe("Saving into the Node Banana folder", () => {
    const ROOT = "/Users/me/Documents/Node Banana";
    /** Folders already in the Node Banana folder, lower-cased, as the folder-name route numbers past them. */
    let taken: string[] = [];

    beforeEach(() => {
      taken = [];
      mockLibraryStatus.mockReturnValue({ available: true, root: ROOT });
      mockFetch.mockImplementation((url: string) => {
        if (url.startsWith("/api/assets/projects/folder-name?")) {
          const name = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("name") ?? "";
          let folder = name;
          for (let n = 2; taken.includes(folder.toLowerCase()); n++) folder = `${name} ${n}`;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ folder, path: `${ROOT}/${folder}`, taken: folder !== name }),
          });
        }
        if (url.startsWith("/api/workflow?")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, exists: false }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    });

    afterEach(() => {
      mockLibraryStatus.mockReturnValue(null);
    });

    it("saves a new project in a folder of its own there, named after it", async () => {
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);
      expect(screen.queryByLabelText("Project directory")).toBeNull();

      fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "Lookbook" } });
      expect(await screen.findByText("~/Documents/Node Banana/Lookbook")).toBeInTheDocument();
      expect(screen.getByText(/Saves to/)).toBeInTheDocument();

      fireEvent.click(screen.getByText("Create"));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Lookbook", `${ROOT}/Lookbook`));
      // Only a chosen directory is remembered as the next one to offer
      expect(localStorageMock.setItem).not.toHaveBeenCalledWith("node-banana-last-project-dir", expect.anything());
    });

    it("numbers the folder past one that is taken, and says why", async () => {
      taken = ["lookbook"];
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);

      fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "Lookbook" } });
      expect(await screen.findByText("~/Documents/Node Banana/Lookbook 2")).toBeInTheDocument();
      expect(screen.getByText("There’s already a “Lookbook” folder there, so this one gets a number.")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Create"));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Lookbook", `${ROOT}/Lookbook 2`));
    });

    it("chooses another location, starting at the Node Banana folder, and comes back", async () => {
      const onSave = vi.fn();
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={onSave} mode="new" />);
      fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "Fox" } });

      fireEvent.click(screen.getByText("Choose another location…"));
      expect(screen.getByLabelText("Project directory")).toHaveValue(ROOT);
      expect(screen.getByText("Only this project is saved here. Its generations still show in Assets.")).toBeInTheDocument();
      expect(screen.queryByText(/Saves to/)).toBeNull();

      fireEvent.change(screen.getByLabelText("Project directory"), { target: { value: "/projects" } });
      fireEvent.click(screen.getByText("Create"));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith("mock-workflow-id", "Fox", "/projects/Fox"));

      fireEvent.click(screen.getByText("Use the Node Banana folder"));
      expect(screen.queryByLabelText("Project directory")).toBeNull();
      expect(await screen.findByText("~/Documents/Node Banana/Fox")).toBeInTheDocument();
    });

    it("keeps a saved project's own directory in its settings", () => {
      mockUseWorkflowStore.mockImplementation((selector) =>
        selector(createDefaultState({ workflowName: "Fox", saveDirectoryPath: "/projects/Fox" }))
      );
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={vi.fn()} mode="settings" />);
      expect(screen.getByLabelText("Project directory")).toHaveValue("/projects/Fox");
      expect(screen.getByText("Use the Node Banana folder")).toBeInTheDocument();
    });

    it("asks for a directory when there is no Node Banana folder", () => {
      mockLibraryStatus.mockReturnValue({ available: false, root: null });
      render(<ProjectSetupModal isOpen onClose={vi.fn()} onSave={vi.fn()} mode="new" />);
      expect(screen.getByLabelText("Project directory")).toBeInTheDocument();
      expect(screen.queryByText("Use the Node Banana folder")).toBeNull();
      expect(screen.queryByText("Choose another location…")).toBeNull();
    });
  });

  describe("Browse Button", () => {
    it("should call browse-directory API when Browse is clicked", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, path: "/selected/path" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith("/api/browse-directory");
      });
    });

    it("should keep selected parent path in input after browse", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, path: "/selected/path" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
        expect(directoryInput.value).toBe("/selected/path");
      });
    });

    it("should keep selected path when project name is empty", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, path: "/selected/path" }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
        expect(directoryInput.value).toBe("/selected/path");
      });
    });

    it("should show '...' while browsing", async () => {
      let resolvePromise: ((value: unknown) => void) | undefined;
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return new Promise((resolve) => {
            resolvePromise = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Browse"));

      expect(screen.getByText("...")).toBeInTheDocument();

      resolvePromise!({
        ok: true,
        json: () => Promise.resolve({ success: true, cancelled: true }),
      });
    });

    it("should handle cancelled browse dialog", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, cancelled: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="new"
        />
      );

      // Pre-fill directory
      const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
      fireEvent.change(directoryInput, { target: { value: "/original/path" } });

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        // Should keep original value when cancelled
        expect(directoryInput.value).toBe("/original/path");
      });
    });

    it("should save using latest project name when renamed after browse", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url === "/api/browse-directory") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, path: "/selected/path" }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: false, isDirectory: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "Foo" },
      });

      fireEvent.click(screen.getByText("Browse"));

      await waitFor(() => {
        const directoryInput = screen.getByPlaceholderText("/Users/username/projects/my-project") as HTMLInputElement;
        expect(directoryInput.value).toBe("/selected/path");
      });

      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "Bar" },
      });

      fireEvent.click(screen.getByText("Create"));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          "mock-workflow-id",
          "Bar",
          "/selected/path/Bar"
        );
      });
    });
  });

  describe("Cancel Button", () => {
    it("should call onClose when Cancel is clicked", () => {
      const onClose = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.click(screen.getByText("Cancel"));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("Keyboard Shortcuts", () => {
    it("should close modal when Escape is pressed", () => {
      const onClose = vi.fn();

      const { container } = render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="new"
        />
      );

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      expect(onClose).toHaveBeenCalled();
    });

    it("should submit form when Enter is pressed", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: false, openai: false, replicate: false, fal: false }),
          });
        }
        if (url.startsWith("/api/workflow")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ exists: true, isDirectory: true }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      const onSave = vi.fn();

      const { container } = render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={onSave}
          mode="new"
        />
      );

      // Fill fields
      fireEvent.change(screen.getByPlaceholderText("my-project"), {
        target: { value: "My Project" },
      });
      fireEvent.change(screen.getByPlaceholderText("/Users/username/projects/my-project"), {
        target: { value: "/path/to/project" },
      });

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

      await waitFor(() => {
        expect(onSave).toHaveBeenCalled();
      });
    });

    it("should not save and close when Enter is pressed inside the model browser", async () => {
      const onClose = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByText("Node defaults"));
      fireEvent.click(screen.getAllByText("Select model")[0]);

      const search = screen.getByPlaceholderText("Search models...");
      fireEvent.keyDown(search, { key: "Enter" });

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("model-search-dialog")).toBeInTheDocument();

      // The pick still lands in the draft, and the settings dialog stays open.
      fireEvent.click(screen.getByText("Test Model"));
      expect(screen.queryByTestId("model-search-dialog")).not.toBeInTheDocument();
      expect(screen.getByText("Test Model")).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("Providers Tab", () => {
    // The default beforeEach already sets up proper mocks for env-status

    it("should render all provider sections", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      await waitFor(() => {
        expect(screen.getByText("Google Gemini")).toBeInTheDocument();
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Replicate")).toBeInTheDocument();
        expect(screen.getByText("fal.ai")).toBeInTheDocument();
        // "ComfyUI" is also the settings tab label, so the provider row is
        // identified by its key input as well.
        expect(screen.getAllByText("ComfyUI").length).toBeGreaterThanOrEqual(2);
        expect(screen.getByLabelText("ComfyUI API key")).toBeInTheDocument();
      });
    });

    it("the ComfyUI page reports the Comfy key from Providers and links there", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "ComfyUI" }));
      await waitFor(() => {
        expect(screen.getByText("No Comfy key yet")).toBeInTheDocument();
        expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: /Add in Providers/ }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText("comfyui-...")).toBeInTheDocument();
      });
      fireEvent.change(screen.getByLabelText("ComfyUI API key"), { target: { value: "comfyui-abc" } });

      fireEvent.click(screen.getByRole("button", { name: "ComfyUI" }));
      await waitFor(() => {
        expect(screen.getByText("Using your Comfy key")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Change/ })).toBeInTheDocument();
      });
    });

    it("should show API key inputs for each provider", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      await waitFor(() => {
        // Check for placeholder texts
        expect(screen.getByPlaceholderText("AIza...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("sk-...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("r8_...")).toBeInTheDocument();
        expect(screen.getByPlaceholderText("comfyui-...")).toBeInTheDocument();
      });
    });

    it("should show 'Configured via .env' when provider has env key", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: true, openai: false, replicate: false, fal: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      await waitFor(() => {
        expect(screen.getByText("Configured via .env")).toBeInTheDocument();
      });
    });

    it("should show Override button for env-configured providers", async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === "/api/env-status") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ gemini: true, openai: false, replicate: false, fal: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      });

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      await waitFor(() => {
        expect(screen.getByText("Override")).toBeInTheDocument();
      });
    });

    it("should toggle Show/Hide for API key visibility", async () => {
      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={vi.fn()}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      // Nothing to reveal while every field is empty
      await waitFor(() => {
        expect(screen.getByLabelText("OpenAI API key")).toBeInTheDocument();
      });
      expect(screen.queryByText("Show")).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("OpenAI API key"), { target: { value: "sk-test" } });
      await waitFor(() => {
        expect(screen.getAllByText("Show")).toHaveLength(1);
      });

      fireEvent.click(screen.getByText("Show"));
      await waitFor(() => {
        expect(screen.getByText("Hide")).toBeInTheDocument();
      });
    });

    it("should call onClose when Save is clicked on Providers tab", async () => {
      const onClose = vi.fn();

      render(
        <ProjectSetupModal
          isOpen={true}
          onClose={onClose}
          onSave={vi.fn()}
          mode="settings"
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Providers" }));

      await waitFor(() => {
        expect(screen.getByText("Google Gemini")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("Save"));

      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe("Noodles tab", () => {
  // One stable object: the modal syncs it into local state in an effect,
  // and a fresh object per render would loop.
  const navSettings = { panMode: "space", zoomMode: "altScroll", selectionMode: "click" };

  it("shows the connection settings under their own tab", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ canvasNavigationSettings: navSettings }))
    );
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    render(<ProjectSetupModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} mode="settings" />);
    fireEvent.click(screen.getByRole("button", { name: "Noodles" }));
    expect(screen.getByTestId("connection-preview")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Curved" })).toHaveAttribute("aria-checked", "true");
    // The Canvas tab no longer carries them
    fireEvent.click(screen.getByRole("button", { name: "Canvas" }));
    expect(screen.queryByTestId("connection-preview")).toBeNull();
  });
});

describe("Storage page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The env status plays no part here; left pending, it cannot update after a test ends.
    mockFetch.mockReturnValue(new Promise(() => {}));
    mockUseWorkflowStore.mockImplementation((selector) => selector(createDefaultState()));
  });

  it("sits second in the rail, after Project", () => {
    render(<ProjectSetupModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} mode="settings" />);
    const rail = screen.getByRole("navigation", { name: "Settings pages" });
    const pages = Array.from(rail.querySelectorAll("button")).map((button) => button.textContent);
    expect(pages.slice(0, 3)).toEqual(["Project", "Storage", "Providers"]);
  });

  it("opens on the Storage page when asked, with Done in place of Cancel and Save", () => {
    const onClose = vi.fn();
    render(<ProjectSetupModal isOpen={true} onClose={onClose} onSave={vi.fn()} mode="settings" initialTab="library" />);
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("Where your projects and generations are saved.")).toBeInTheDocument();
    expect(screen.getByTestId("library-settings")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockUpdateProviderApiKey).not.toHaveBeenCalled();
  });

  it("moves an open dialog to a newly requested page, and only on a new request", () => {
    const props = { isOpen: true, onClose: vi.fn(), onSave: vi.fn(), mode: "settings" as const };
    const { rerender } = render(<ProjectSetupModal {...props} initialTab="project" pageRequest={1} />);
    expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute("aria-current", "page");

    rerender(<ProjectSetupModal {...props} initialTab="library" pageRequest={2} />);
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("library-settings")).toBeInTheDocument();

    // The user moves on; a re-render without a new request leaves them there
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));
    rerender(<ProjectSetupModal {...props} initialTab="library" pageRequest={2} />);
    expect(screen.getByRole("button", { name: "Providers" })).toHaveAttribute("aria-current", "page");

    // The same page asked for again
    rerender(<ProjectSetupModal {...props} initialTab="library" pageRequest={3} />);
    expect(screen.getByRole("button", { name: "Storage" })).toHaveAttribute("aria-current", "page");
  });

  it("renders into the body, so it opens while its host is hidden", () => {
    const { container } = render(
      <div hidden>
        <ProjectSetupModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} mode="settings" initialTab="library" />
      </div>
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("Canvas tab: low detail and the performance overlay", () => {
  // One stable object: the modal syncs it into local state in an effect
  const navSettings = { panMode: "space", zoomMode: "altScroll", selectionMode: "click" };

  it("switches low detail, sets the zoom it starts below and shows the overlay, all on Save", async () => {
    const { getLowDetailSettings, setLowDetailEnabled, setLowDetailZoom } = await import("@/components/nodes/lowDetail");
    const { getPerfOverlayVisible, setPerfOverlayVisible } = await import("@/components/PerfOverlay");
    setLowDetailEnabled(true);
    setLowDetailZoom(0.25);
    setPerfOverlayVisible(false);
    const updateCanvasNavigationSettings = vi.fn();
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ canvasNavigationSettings: navSettings, updateCanvasNavigationSettings }))
    );
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    const onClose = vi.fn();
    render(<ProjectSetupModal isOpen={true} onClose={onClose} onSave={vi.fn()} mode="settings" initialTab="canvas" />);

    const lowDetail = screen.getByRole("switch", { name: "Low detail when zoomed out" });
    const below = screen.getByRole("slider", { name: "Low detail below" });
    expect(lowDetail).toHaveAttribute("aria-checked", "true");
    expect(below).toHaveValue("25");
    fireEvent.change(below, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("switch", { name: "Performance overlay" }));
    // Nothing applies before Save
    expect(getLowDetailSettings().zoom).toBe(0.25);
    expect(getPerfOverlayVisible()).toBe(false);

    fireEvent.click(screen.getByText("Save"));
    expect(getLowDetailSettings()).toEqual({ enabled: true, zoom: 0.4 });
    expect(getPerfOverlayVisible()).toBe(true);
    expect(onClose).toHaveBeenCalled();
    setPerfOverlayVisible(false);
  });

  it("greys the zoom out while low detail is off", () => {
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ canvasNavigationSettings: navSettings, updateCanvasNavigationSettings: vi.fn() }))
    );
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    render(<ProjectSetupModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} mode="settings" initialTab="canvas" />);
    fireEvent.click(screen.getByRole("switch", { name: "Low detail when zoomed out" }));
    expect(screen.getByRole("slider", { name: "Low detail below" })).toBeDisabled();
  });

  it("sets how the canvas trades speed for detail, all on Save", async () => {
    const { getCanvasSettings, setCanvasSettings, DEFAULT_CANVAS_SETTINGS } = await import("@/lib/gpuCanvas/canvasSettings");
    setCanvasSettings(DEFAULT_CANVAS_SETTINGS);
    mockUseWorkflowStore.mockImplementation((selector) =>
      selector(createDefaultState({ canvasNavigationSettings: navSettings, updateCanvasNavigationSettings: vi.fn() }))
    );
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    render(<ProjectSetupModal isOpen={true} onClose={vi.fn()} onSave={vi.fn()} mode="settings" initialTab="canvas" />);

    fireEvent.click(screen.getByRole("switch", { name: "Wait for nodes when opening" }));
    fireEvent.click(screen.getByRole("switch", { name: "Loading screen for large workflows" }));
    fireEvent.change(screen.getByRole("slider", { name: "Connection details from" }), { target: { value: "50" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Picture quality in a browser" })).getByRole("button", { name: "Sharp" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Nodes in a browser" })).getByRole("button", { name: "Live" }));
    // Picture quality has no say over live nodes
    expect(within(screen.getByRole("group", { name: "Picture quality in a browser" })).getByRole("button", { name: "Sharp" })).toBeDisabled();
    expect(getCanvasSettings()).toEqual(DEFAULT_CANVAS_SETTINGS);

    fireEvent.click(screen.getByText("Save"));
    expect(getCanvasSettings()).toEqual({ browserNodes: "live", pictureQuality: "sharp", waitForPaint: false, loadingScreen: false, connectionDetailZoom: 0.5 });
    setCanvasSettings(DEFAULT_CANVAS_SETTINGS);
  });
});
