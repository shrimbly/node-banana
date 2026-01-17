/**
 * Tests for Image Analysis Utilities
 *
 * These tests verify the core image analysis functions used by
 * the ConditionalBranchNode for making routing decisions.
 */

import { colorMatches } from "../imageAnalysis";

describe("imageAnalysis", () => {
  describe("colorMatches", () => {
    it("should match exact named colors", () => {
      // Red hex should match "red" named color
      expect(colorMatches("#ff0000", "red")).toBe(true);
      expect(colorMatches("#00ff00", "green")).toBe(true);
      expect(colorMatches("#0000ff", "blue")).toBe(true);
    });

    it("should match colors within tolerance", () => {
      // Slightly off-red should still match "red"
      expect(colorMatches("#e00000", "red")).toBe(true);
      expect(colorMatches("#ff2020", "red")).toBe(true);
    });

    it("should not match distant colors", () => {
      // Blue should not match red
      expect(colorMatches("#0000ff", "red")).toBe(false);
      // Green should not match blue
      expect(colorMatches("#00ff00", "blue")).toBe(false);
    });

    it("should handle case-insensitive color names", () => {
      expect(colorMatches("#ff0000", "RED")).toBe(true);
      expect(colorMatches("#ff0000", "Red")).toBe(true);
    });

    it("should match hex color to hex color", () => {
      expect(colorMatches("#ff0000", "#ff0000")).toBe(true);
      expect(colorMatches("#ff0000", "#fe0101")).toBe(true);
    });

    it("should handle gray/grey spelling", () => {
      expect(colorMatches("#808080", "gray")).toBe(true);
      expect(colorMatches("#808080", "grey")).toBe(true);
    });

    it("should return false for unknown color names", () => {
      expect(colorMatches("#ff0000", "chartreuse")).toBe(false);
      expect(colorMatches("#ff0000", "not-a-color")).toBe(false);
    });

    it("should respect custom tolerance parameter", () => {
      // The default tolerance is 80 (Euclidean distance in RGB space)
      // #ff5050 is rgb(255, 80, 80) - distance from pure red (255, 0, 0):
      // sqrt((255-255)^2 + (0-80)^2 + (0-80)^2) = sqrt(0 + 6400 + 6400) ≈ 113

      // With tight tolerance of 50, this color should NOT match red
      expect(colorMatches("#ff5050", "red", 50)).toBe(false);

      // With tolerance of 120, this color SHOULD match red (distance ≈ 113 < 120)
      expect(colorMatches("#ff5050", "red", 120)).toBe(true);

      // With generous tolerance of 150, should definitely match
      expect(colorMatches("#ff5050", "red", 150)).toBe(true);

      // Test boundary case: exact distance is ~113, so 113 should just fail, 114 should pass
      expect(colorMatches("#ff5050", "red", 110)).toBe(false);
      expect(colorMatches("#ff5050", "red", 115)).toBe(true);
    });
  });
});
