"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { useFTUXStore } from "@/store/ftuxStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { ElementHighlight } from "./ElementHighlight";
import { TutorialMessage } from "./TutorialMessage";
import { getTutorialSampleContent } from "@/utils/tutorialDefaults";

/**
 * Main tutorial coordination component.
 * Manages tutorial progression, action detection, and UI rendering.
 */
export function TutorialOverlay() {
  const [mounted, setMounted] = useState(false);
  const [showHighlight, setShowHighlight] = useState(false);
  const nodesPopulated = useRef(false);
  const demonstrateNodesAdded = useRef(false);

  const tutorialActive = useFTUXStore((state) => state.tutorialActive);
  const currentTutorialStep = useFTUXStore((state) => state.currentTutorialStep);
  const tutorialSteps = useFTUXStore((state) => state.tutorialSteps);
  const completeCurrentStep = useFTUXStore((state) => state.completeCurrentStep);
  const nextTutorialStep = useFTUXStore((state) => state.nextTutorialStep);
  const skipTutorial = useFTUXStore((state) => state.skipTutorial);
  const connectionMenuShown = useFTUXStore((state) => state.connectionMenuShown);
  const nanoBananaAddedFromMenu = useFTUXStore((state) => state.nanoBananaAddedFromMenu);
  const tutorialSampleImage = useFTUXStore((state) => state.tutorialSampleImage);

  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  // Ensure portal rendering only happens client-side
  useEffect(() => {
    setMounted(true);
  }, []);

  // Action detection: monitor workflow state for required actions
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];
    if (currentStep.completed) {
      return;
    }

    // Steps with waitForClick require manual progression
    if (currentStep.waitForClick) {
      return;
    }

    // Steps without requiredAction auto-advance after 3 seconds
    if (!currentStep.requiredAction) {
      const timer = setTimeout(() => {
        completeCurrentStep();
        nextTutorialStep();
      }, 3000);
      return () => clearTimeout(timer);
    }

    let actionCompleted = false;

    // Detect specific actions based on requiredAction type
    switch (currentStep.requiredAction) {
      case "add-image-node":
        actionCompleted = nodes.some((node) => node.type === "imageInput");
        break;

      case "add-output-node":
        actionCompleted = nodes.some((node) => node.type === "output");
        break;

      case "connect-nodes":
        // Check if any edges exist
        actionCompleted = edges.length > 0;
        break;

      case "run-workflow":
        // Check if any node has been executed (has output)
        actionCompleted = nodes.some((node) => {
          const data = node.data as Record<string, unknown>;
          return data.outputImage || data.outputText || data.outputAudio;
        });
        break;

      case "show-connection-menu":
        actionCompleted = connectionMenuShown;
        break;

      case "add-nanoBanana-from-menu":
        actionCompleted = nanoBananaAddedFromMenu;
        break;

      case "add-prompt-node":
        actionCompleted = nodes.some((node) => node.type === "prompt");
        break;

      case "connect-prompt-node":
        // Check if any edge has a prompt node as source
        actionCompleted = edges.some((edge) => {
          const sourceNode = nodes.find((n) => n.id === edge.source);
          return sourceNode?.type === "prompt";
        });
        break;
    }

    if (actionCompleted) {
      completeCurrentStep();
      // Advance to next step after configurable delay (default 1000ms)
      const delay = currentStep.advanceDelay !== undefined ? currentStep.advanceDelay : 1000;
      setTimeout(() => {
        nextTutorialStep();
      }, delay);
    }
  }, [
    tutorialActive,
    currentTutorialStep,
    tutorialSteps,
    nodes,
    edges,
    connectionMenuShown,
    nanoBananaAddedFromMenu,
    completeCurrentStep,
    nextTutorialStep,
  ]);

  // Handle highlight delay
  useEffect(() => {
    if (!tutorialActive || currentTutorialStep >= tutorialSteps.length) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    if (currentStep.highlightSelector && currentStep.highlightDelay) {
      // Start with highlight hidden
      setShowHighlight(false);
      // Show highlight after delay
      const timer = setTimeout(() => {
        setShowHighlight(true);
      }, currentStep.highlightDelay);
      return () => clearTimeout(timer);
    } else {
      // No delay, show highlight immediately
      setShowHighlight(true);
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps]);

  // Auto-populate nodes during the populate-content step
  useEffect(() => {
    if (!tutorialActive || nodesPopulated.current) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    // Check if we're on the "populate-content" step
    if (currentStep?.id === "populate-content" && !currentStep.completed) {
      nodesPopulated.current = true;

      // Wait a bit before populating to show the message first
      setTimeout(() => {
        // Find the image input and prompt nodes
        const imageInputNode = nodes.find((node) => node.type === "imageInput");
        const promptNode = nodes.find((node) => node.type === "prompt");

        // Populate with sample content
        if (imageInputNode) {
          const imageContent = getTutorialSampleContent("imageInput", tutorialSampleImage);
          if (imageContent) {
            updateNodeData(imageInputNode.id, imageContent);
          }
        }

        if (promptNode) {
          const promptContent = getTutorialSampleContent("prompt", tutorialSampleImage);
          if (promptContent) {
            updateNodeData(promptNode.id, promptContent);
          }
        }

        // Auto-advance after populating
        setTimeout(() => {
          completeCurrentStep();
          nextTutorialStep();
        }, 1500);
      }, 1000);
    }

    // Reset ref when tutorial ends
    if (!tutorialActive) {
      nodesPopulated.current = false;
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps, nodes, tutorialSampleImage, updateNodeData, completeCurrentStep, nextTutorialStep]);

  // Auto-add downstream demonstration nodes
  useEffect(() => {
    if (!tutorialActive || demonstrateNodesAdded.current) {
      return;
    }

    const currentStep = tutorialSteps[currentTutorialStep];

    if (currentStep?.id === "demonstrate-downstream" && !currentStep.completed) {
      demonstrateNodesAdded.current = true;
      const addNode = useWorkflowStore.getState().addNode;
      const onConnect = useWorkflowStore.getState().onConnect;
      const updateNodeData = useWorkflowStore.getState().updateNodeData;

      // Initial delay to show message
      setTimeout(() => {
        // Find the Generate Image node
        const generateNode = nodes.find((n) => n.type === "nanoBanana");
        if (!generateNode) return;

        const baseX = generateNode.position.x;
        const baseY = generateNode.position.y;

        // VIDEO BRANCH (top) - Clean horizontal layout with generous spacing
        // Add Prompt node for video
        const videoPromptId = addNode("prompt", {
          x: baseX + 400,
          y: baseY - 350,
        });

        setTimeout(() => {
          // Add Generate Video node
          const videoNodeId = addNode("generateVideo", {
            x: baseX + 750,
            y: baseY - 350,
          });

          setTimeout(() => {
            // Connect Prompt → Video (text)
            onConnect({
              source: videoPromptId,
              target: videoNodeId,
              sourceHandle: "text",
              targetHandle: "text",
            });

            setTimeout(() => {
              // Connect Image → Video (image)
              onConnect({
                source: generateNode.id,
                target: videoNodeId,
                sourceHandle: "image",
                targetHandle: "image",
              });

              setTimeout(() => {
                // Populate video prompt
                updateNodeData(videoPromptId, {
                  prompt: "A bird soaring through clouds at sunset",
                });

                setTimeout(() => {
                  // Add Output for video
                  const videoOutputId = addNode("output", {
                    x: baseX + 1100,
                    y: baseY - 350,
                  });

                  setTimeout(() => {
                    // Connect Video → Output
                    onConnect({
                      source: videoNodeId,
                      target: videoOutputId,
                      sourceHandle: "video",
                      targetHandle: "video",
                    });

                    // LLM ANALYSIS BRANCH (bottom) - Clean horizontal layout with generous spacing
                    setTimeout(() => {
                      // Add Prompt node for LLM
                      const llmPromptId = addNode("prompt", {
                        x: baseX + 400,
                        y: baseY + 350,
                      });

                      setTimeout(() => {
                        // Add LLM Generate node
                        const llmNodeId = addNode("llmGenerate", {
                          x: baseX + 750,
                          y: baseY + 350,
                        });

                        setTimeout(() => {
                          // Connect Prompt → LLM (text)
                          onConnect({
                            source: llmPromptId,
                            target: llmNodeId,
                            sourceHandle: "text",
                            targetHandle: "text",
                          });

                          setTimeout(() => {
                            // Connect Image → LLM (image for analysis)
                            onConnect({
                              source: generateNode.id,
                              target: llmNodeId,
                              sourceHandle: "image",
                              targetHandle: "image",
                            });

                            setTimeout(() => {
                              // Populate LLM prompt
                              updateNodeData(llmPromptId, {
                                prompt:
                                  "Give me an image generation prompt that shows this bird in a nightclub filled with other birds, also in costume. Only output the prompt and nothing else.",
                              });

                              setTimeout(() => {
                                // Add second Generate Image node
                                const generateNode2Id = addNode("nanoBanana", {
                                  x: baseX + 1100,
                                  y: baseY + 350,
                                });

                                setTimeout(() => {
                                  // Connect LLM → Generate Image #2 (text prompt)
                                  onConnect({
                                    source: llmNodeId,
                                    target: generateNode2Id,
                                    sourceHandle: "text",
                                    targetHandle: "text",
                                  });

                                  setTimeout(() => {
                                    // Also connect original bird image as reference
                                    onConnect({
                                      source: generateNode.id,
                                      target: generateNode2Id,
                                      sourceHandle: "image",
                                      targetHandle: "image",
                                    });

                                    setTimeout(() => {
                                      // Add final Output
                                      const finalOutputId = addNode("output", {
                                        x: baseX + 1450,
                                        y: baseY + 350,
                                      });

                                      setTimeout(() => {
                                        // Connect Generate Image #2 → Output
                                        onConnect({
                                          source: generateNode2Id,
                                          target: finalOutputId,
                                          sourceHandle: "image",
                                          targetHandle: "image",
                                        });

                                        // Final delay before advancing
                                        setTimeout(() => {
                                          completeCurrentStep();
                                          nextTutorialStep();
                                        }, 1000);
                                      }, 400);
                                    }, 600);
                                  }, 500);
                                }, 400);
                              }, 600);
                            }, 500);
                          }, 400);
                        }, 400);
                      }, 400);
                    }, 600);
                  }, 400);
                }, 600);
              }, 500);
            }, 400);
          }, 400);
        }, 400);
      }, 1000);
    }

    // Reset ref when tutorial ends
    if (!tutorialActive) {
      demonstrateNodesAdded.current = false;
    }
  }, [tutorialActive, currentTutorialStep, tutorialSteps, nodes, completeCurrentStep, nextTutorialStep]);

  // Don't render during SSR or when tutorial is inactive
  if (!mounted || !tutorialActive || currentTutorialStep >= tutorialSteps.length) {
    return null;
  }

  const currentStep = tutorialSteps[currentTutorialStep];

  const handleContinue = () => {
    completeCurrentStep();
    nextTutorialStep();
  };

  return createPortal(
    <>
      {/* Click-to-continue overlay (when waitForClick is true) */}
      {currentStep.waitForClick && (
        <div
          onClick={handleContinue}
          className="fixed inset-0 cursor-pointer"
          style={{ zIndex: 92 }}
        />
      )}

      {/* Element highlight (if specified and delay has passed) */}
      {currentStep.highlightSelector && showHighlight && (
        <ElementHighlight selector={currentStep.highlightSelector} />
      )}

      {/* Tutorial message - hide if current step is completed */}
      {!currentStep.completed && (
        <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 93 }}>
          <TutorialMessage
            message={currentStep.message}
            position={currentStep.position}
            waitForClick={currentStep.waitForClick}
            links={currentStep.links}
          />
        </div>
      )}

      {/* Skip tutorial button */}
      <button
        onClick={skipTutorial}
        className="fixed top-20 right-4 px-3 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors pointer-events-auto"
        style={{ zIndex: 94 }}
      >
        Skip tutorial
      </button>
    </>,
    document.body
  );
}
