import React, { useState, useEffect, useCallback } from 'react';

const FONT_SIZE_STORAGE_KEY = 'prompt-editor-font-size';
const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const FONT_SIZE_OPTIONS = [10, 12, 14, 16, 18, 20, 24];

interface PromptEditorModalProps {
  isOpen: boolean;
  initialPrompt: string;
  onSubmit: (prompt: string) => void;
  onClose: () => void;
}

export const PromptEditorModal: React.FC<PromptEditorModalProps> = ({
  isOpen,
  initialPrompt,
  onSubmit,
  onClose,
}) => {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [fontSize, setFontSize] = useState(() => {
    // Load font size from localStorage on mount
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) {
          return parsed;
        }
      }
    }
    return DEFAULT_FONT_SIZE;
  });

  // Update local state when initial prompt changes
  useEffect(() => {
    setPrompt(initialPrompt);
  }, [initialPrompt]);

  // Save font size to localStorage when it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, fontSize.toString());
    }
  }, [fontSize]);

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleSubmit = useCallback(() => {
    onSubmit(prompt);
    onClose();
  }, [prompt, onSubmit, onClose]);

  const handleFontSizeChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setFontSize(parseInt(e.target.value, 10));
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only close if clicking the backdrop itself, not the dialog content
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={handleBackdropClick}
    >
      <div className="bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-3xl h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-xl font-semibold text-neutral-100">
            Edit Prompt
          </h2>
        </div>

        {/* Box containing toolbar and textarea */}
        <div className="mx-6 flex-1 flex flex-col border border-neutral-700 rounded bg-neutral-900/30 overflow-hidden mb-4">
          {/* Toolbar - header of the box */}
          <div className="h-12 bg-neutral-900 border-b border-neutral-700 flex items-center px-4 gap-3 shrink-0">
            {/* Font Size Control */}
            <select
              value={fontSize}
              onChange={handleFontSizeChange}
              className="text-sm py-1 px-2 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
            >
              {FONT_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </select>
          </div>

          {/* Textarea */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what to generate..."
            className="nodrag nopan nowheel flex-1 w-full p-6 leading-relaxed text-neutral-100 bg-transparent border-0 resize-none focus:outline-none placeholder:text-neutral-500"
            style={{ fontSize: `${fontSize}px` }}
            autoFocus
          />
        </div>

        {/* Footer with buttons */}
        <div className="flex justify-end gap-3 px-6 pb-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-neutral-500"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors focus:outline-none focus:ring-1 focus:ring-blue-400"
          >
            Submit
          </button>
        </div>
      </div>
    </div>
  );
};
