import { useEffect, useRef } from 'react';
import { useReactFlow } from '@xyflow/react';

interface TrackpadGesturesOptions {
  enabled?: boolean;
  minZoom?: number;
  maxZoom?: number;
  zoomSpeed?: number;
}

// Safari gesture event types (not in standard TypeScript)
interface GestureEvent extends UIEvent {
  scale: number;
  rotation: number;
}

/**
 * Detects if the user is on macOS with a trackpad
 */
function isMacOSTrackpad(): boolean {
  // Check if running on macOS
  const isMacOS = navigator.platform.toUpperCase().indexOf('MAC') >= 0 || 
                  navigator.userAgent.toUpperCase().indexOf('MAC') >= 0;
  
  if (!isMacOS) return false;

  // Trackpads typically have high-precision wheel events
  // This is a heuristic - we'll also detect based on event characteristics
  return true;
}

/**
 * Custom hook for macOS trackpad gestures on React Flow canvas
 * Supports:
 * - Pinch to zoom (two-finger pinch)
 * - Smooth scrolling/panning
 * - Gesture events (Safari)
 */
export function useTrackpadGestures(options: TrackpadGesturesOptions = {}) {
  const {
    enabled = true,
    minZoom = 0.1,
    maxZoom = 4,
    zoomSpeed = 0.01,
  } = options;

  const { setViewport, getViewport } = useReactFlow();
  const isTrackpad = useRef<boolean>(false);
  const lastScale = useRef<number>(1);
  const gestureInProgress = useRef<boolean>(false);

  useEffect(() => {
    if (!enabled) return;

    // Check if we're on macOS with a trackpad
    isTrackpad.current = isMacOSTrackpad();
    
    if (!isTrackpad.current) {
      console.log('[TrackpadGestures] Not on macOS trackpad, disabling gesture controls');
      return;
    }

    console.log('[TrackpadGestures] macOS trackpad detected, enabling gesture controls');

    const handleWheel = (event: WheelEvent) => {
      // Pinch-to-zoom: On macOS, pinch gestures come as wheel events with ctrlKey
      if (event.ctrlKey) {
        event.preventDefault();
        gestureInProgress.current = true;

        const viewport = getViewport();
        const delta = -event.deltaY;
        
        // Calculate zoom change
        const zoomChange = delta * zoomSpeed;
        const newZoom = Math.min(Math.max(viewport.zoom + zoomChange, minZoom), maxZoom);

        // Get the mouse position relative to the canvas
        const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;

        // Calculate the point in flow coordinates before zoom
        const pointX = (x - viewport.x) / viewport.zoom;
        const pointY = (y - viewport.y) / viewport.zoom;

        // Calculate new viewport position to zoom towards cursor
        const newX = x - pointX * newZoom;
        const newY = y - pointY * newZoom;

        setViewport({ x: newX, y: newY, zoom: newZoom }, { duration: 0 });
      }
      // Smooth scrolling/panning with two fingers
      else if (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) > 0) {
        // Detect high-precision scrolling (typical of trackpads)
        const isPrecisionScroll = Math.abs(event.deltaY) < 50 && 
                                  Math.abs(event.deltaX) < 50 &&
                                  event.deltaMode === 0;

        if (isPrecisionScroll) {
          event.preventDefault();
          const viewport = getViewport();
          
          // Apply pan with smooth multiplier
          const panSpeed = 1.0;
          setViewport(
            {
              x: viewport.x - event.deltaX * panSpeed,
              y: viewport.y - event.deltaY * panSpeed,
              zoom: viewport.zoom,
            },
            { duration: 0 }
          );
        }
      }
    };

    // Safari gesture events (more native support)
    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      gestureInProgress.current = true;
      const gestureEvent = event as unknown as GestureEvent;
      lastScale.current = gestureEvent.scale;
    };

    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as unknown as GestureEvent;
      
      const viewport = getViewport();
      const scaleDelta = gestureEvent.scale / lastScale.current;
      const newZoom = Math.min(Math.max(viewport.zoom * scaleDelta, minZoom), maxZoom);

      // Get the center of the gesture
      const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const centerX = bounds.width / 2;
      const centerY = bounds.height / 2;

      // Calculate the point in flow coordinates before zoom
      const pointX = (centerX - viewport.x) / viewport.zoom;
      const pointY = (centerY - viewport.y) / viewport.zoom;

      // Calculate new viewport position
      const newX = centerX - pointX * newZoom;
      const newY = centerY - pointY * newZoom;

      setViewport({ x: newX, y: newY, zoom: newZoom }, { duration: 0 });
      lastScale.current = gestureEvent.scale;
    };

    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
      gestureInProgress.current = false;
      lastScale.current = 1;
    };

    // Find the React Flow viewport element
    const viewport = document.querySelector('.react-flow__viewport')?.parentElement;
    
    if (!viewport) {
      console.warn('[TrackpadGestures] Could not find React Flow viewport element');
      return;
    }

    // Add wheel event listener for pinch-to-zoom and smooth scrolling
    viewport.addEventListener('wheel', handleWheel, { passive: false });

    // Add Safari gesture events if available
    if ('ongesturestart' in window) {
      viewport.addEventListener('gesturestart', handleGestureStart);
      viewport.addEventListener('gesturechange', handleGestureChange);
      viewport.addEventListener('gestureend', handleGestureEnd);
    }

    return () => {
      viewport.removeEventListener('wheel', handleWheel);
      if ('ongesturestart' in window) {
        viewport.removeEventListener('gesturestart', handleGestureStart);
        viewport.removeEventListener('gesturechange', handleGestureChange);
        viewport.removeEventListener('gestureend', handleGestureEnd);
      }
    };
  }, [enabled, minZoom, maxZoom, zoomSpeed, setViewport, getViewport]);

  return {
    isTrackpadDetected: isTrackpad.current,
  };
}

