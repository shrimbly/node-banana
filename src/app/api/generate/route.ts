import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { GenerateRequest, GenerateResponse, ModelType, AzureFluxSize, AzureGptImageSize, AzureGptImageQuality } from "@/types";

export const maxDuration = 300; // 5 minute timeout for API calls
export const dynamic = 'force-dynamic'; // Ensure this route is always dynamic

// Map model types to Gemini model IDs (for Gemini-based models)
const GEMINI_MODEL_MAP: Record<string, string> = {
  "nano-banana": "gemini-2.5-flash-image",
  "nano-banana-pro": "gemini-3-pro-image-preview",
};

// Azure Foundry configuration
// These endpoints can be customized via environment variables
const AZURE_FLUX_ENDPOINT = process.env.AZURE_FLUX_ENDPOINT || "https://your-resource.openai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview";
const AZURE_GPT_IMAGE_ENDPOINT = process.env.AZURE_GPT_IMAGE_ENDPOINT || "https://your-resource.openai.azure.com/openai/v1/images/generations";

// Map aspect ratios to Azure FLUX sizes
const ASPECT_RATIO_TO_SIZE: Record<string, AzureFluxSize> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  // Default fallback for other ratios
};

// Map aspect ratios to Azure GPT Image sizes
const ASPECT_RATIO_TO_GPT_SIZE: Record<string, AzureGptImageSize> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  // Default fallback for other ratios
};

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);
  console.log(`\n[API:${requestId}] ========== NEW GENERATE REQUEST ==========`);
  console.log(`[API:${requestId}] Timestamp: ${new Date().toISOString()}`);

  try {
    console.log(`[API:${requestId}] Parsing request body...`);
    const body: GenerateRequest = await request.json();
    const { images, prompt, model = "nano-banana-pro", aspectRatio, resolution, useGoogleSearch, size, gptImageSize, gptImageQuality } = body;

    console.log(`[API:${requestId}] Request parameters:`);
    console.log(`[API:${requestId}]   - Model: ${model}`);
    console.log(`[API:${requestId}]   - Images count: ${images?.length || 0}`);
    console.log(`[API:${requestId}]   - Prompt length: ${prompt?.length || 0} chars`);
    console.log(`[API:${requestId}]   - Aspect Ratio: ${aspectRatio || 'default'}`);
    console.log(`[API:${requestId}]   - Resolution: ${resolution || 'default'}`);
    console.log(`[API:${requestId}]   - Size: ${size || 'default'}`);
    console.log(`[API:${requestId}]   - GPT Image Size: ${gptImageSize || 'default'}`);
    console.log(`[API:${requestId}]   - GPT Image Quality: ${gptImageQuality || 'default'}`);
    console.log(`[API:${requestId}]   - Google Search: ${useGoogleSearch || false}`);

    // Route to Azure FLUX if that model is selected
    if (model === "azure-flux-pro") {
      return handleAzureFluxGeneration(requestId, prompt, aspectRatio, size);
    }

    // Route to Azure GPT Image if that model is selected
    if (model === "azure-gpt-image") {
      return handleAzureGptImageGeneration(requestId, prompt, aspectRatio, gptImageSize, gptImageQuality);
    }

    // Continue with Gemini-based generation for other models
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      console.error(`[API:${requestId}] ❌ No Gemini API key configured for model: ${model}`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Gemini API key not configured for model "${model}". Either add GEMINI_API_KEY to .env.local or switch to Azure FLUX Pro model.`,
        },
        { status: 500 }
      );
    }

    if (!images || images.length === 0 || !prompt) {
      console.error(`[API:${requestId}] ❌ Validation failed: missing images or prompt`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "At least one image and prompt are required",
        },
        { status: 400 }
      );
    }

    console.log(`[API:${requestId}] Model mapped to: ${GEMINI_MODEL_MAP[model]}`);
    console.log(`[API:${requestId}] Extracting image data...`);
    // Extract base64 data and MIME types from data URLs
    const imageData = images.map((image, idx) => {
      if (image.includes("base64,")) {
        const [header, data] = image.split("base64,");
        // Extract MIME type from header (e.g., "data:image/png;" -> "image/png")
        const mimeMatch = header.match(/data:([^;]+)/);
        const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
        console.log(`[API:${requestId}]   Image ${idx + 1}: ${mimeType}, ${(data.length / 1024).toFixed(2)}KB base64`);
        return { data, mimeType };
      }
      console.log(`[API:${requestId}]   Image ${idx + 1}: No base64 header, assuming PNG, ${(image.length / 1024).toFixed(2)}KB`);
      return { data: image, mimeType: "image/png" };
    });

    // Initialize Gemini client
    console.log(`[API:${requestId}] Initializing Gemini client...`);
    const ai = new GoogleGenAI({ apiKey });

    // Build request parts array with prompt and all images
    console.log(`[API:${requestId}] Building request parts...`);
    const requestParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: prompt },
      ...imageData.map(({ data, mimeType }) => ({
        inlineData: {
          mimeType,
          data,
        },
      })),
    ];
    console.log(`[API:${requestId}] Request parts count: ${requestParts.length} (1 text + ${imageData.length} images)`);

    // Build config object based on model capabilities
    console.log(`[API:${requestId}] Building generation config...`);
    const config: any = {
      responseModalities: ["IMAGE", "TEXT"],
    };

    // Add imageConfig for both models (both support aspect ratio)
    if (aspectRatio) {
      config.imageConfig = {
        aspectRatio,
      };
      console.log(`[API:${requestId}]   Added aspect ratio: ${aspectRatio}`);
    }

    // Add resolution only for Nano Banana Pro
    if (model === "nano-banana-pro" && resolution) {
      if (!config.imageConfig) {
        config.imageConfig = {};
      }
      config.imageConfig.imageSize = resolution;
      console.log(`[API:${requestId}]   Added resolution: ${resolution}`);
    }

    // Add tools array for Google Search (only Nano Banana Pro)
    const tools = [];
    if (model === "nano-banana-pro" && useGoogleSearch) {
      tools.push({ googleSearch: {} });
      console.log(`[API:${requestId}]   Added Google Search tool`);
    }

    console.log(`[API:${requestId}] Final config:`, JSON.stringify(config, null, 2));
    if (tools.length > 0) {
      console.log(`[API:${requestId}] Tools:`, JSON.stringify(tools, null, 2));
    }

    // Make request to Gemini
    console.log(`[API:${requestId}] Calling Gemini API...`);
    const geminiStartTime = Date.now();

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL_MAP[model],
      contents: [
        {
          role: "user",
          parts: requestParts,
        },
      ],
      config,
      ...(tools.length > 0 && { tools }),
    });

    const geminiDuration = Date.now() - geminiStartTime;
    console.log(`[API:${requestId}] Gemini API call completed in ${geminiDuration}ms`);

    // Extract image from response
    console.log(`[API:${requestId}] Processing response...`);
    const candidates = response.candidates;
    console.log(`[API:${requestId}] Candidates count: ${candidates?.length || 0}`);

    if (!candidates || candidates.length === 0) {
      console.error(`[API:${requestId}] ❌ No candidates in response`);
      console.error(`[API:${requestId}] Full response:`, JSON.stringify(response, null, 2));
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "No response from AI model",
        },
        { status: 500 }
      );
    }

    const parts = candidates[0].content?.parts;
    console.log(`[API:${requestId}] Parts count in first candidate: ${parts?.length || 0}`);

    if (!parts) {
      console.error(`[API:${requestId}] ❌ No parts in candidate content`);
      console.error(`[API:${requestId}] Candidate:`, JSON.stringify(candidates[0], null, 2));
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "No content in response",
        },
        { status: 500 }
      );
    }

    // Log all parts
    parts.forEach((part, idx) => {
      const partKeys = Object.keys(part);
      console.log(`[API:${requestId}] Part ${idx + 1}: ${partKeys.join(', ')}`);
    });

    // Find image part in response
    for (const part of parts) {
      if (part.inlineData && part.inlineData.data) {
        const mimeType = part.inlineData.mimeType || "image/png";
        const imageData = part.inlineData.data;
        const imageSizeKB = (imageData.length / 1024).toFixed(2);
        console.log(`[API:${requestId}] ✓ Found image in response: ${mimeType}, ${imageSizeKB}KB base64`);

        const dataUrl = `data:${mimeType};base64,${imageData}`;
        const dataUrlSizeKB = (dataUrl.length / 1024).toFixed(2);
        console.log(`[API:${requestId}] Data URL size: ${dataUrlSizeKB}KB`);

        const responsePayload = { success: true, image: dataUrl };
        const responseSize = JSON.stringify(responsePayload).length;
        const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);
        console.log(`[API:${requestId}] Total response payload size: ${responseSizeMB}MB`);

        if (responseSize > 4.5 * 1024 * 1024) {
          console.warn(`[API:${requestId}] ⚠️ Response size (${responseSizeMB}MB) is approaching Next.js 5MB limit!`);
        }

        console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning image ✓✓✓`);

        // Create response with explicit headers to handle large payloads
        const response = NextResponse.json<GenerateResponse>(responsePayload);
        response.headers.set('Content-Type', 'application/json');
        response.headers.set('Content-Length', responseSize.toString());

        console.log(`[API:${requestId}] Response headers set, returning...`);
        return response;
      }
    }

    // If no image found, check for text error
    console.warn(`[API:${requestId}] ⚠ No image found in parts, checking for text...`);
    for (const part of parts) {
      if (part.text) {
        console.error(`[API:${requestId}] ❌ Model returned text instead of image`);
        console.error(`[API:${requestId}] Text preview: "${part.text.substring(0, 200)}"`);
        return NextResponse.json<GenerateResponse>(
          {
            success: false,
            error: `Model returned text instead of image: ${part.text.substring(0, 200)}`,
          },
          { status: 500 }
        );
      }
    }

    console.error(`[API:${requestId}] ❌ No image or text found in response`);
    console.error(`[API:${requestId}] All parts:`, JSON.stringify(parts, null, 2));
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No image in response",
      },
      { status: 500 }
    );
  } catch (error) {
    const requestId = 'unknown'; // Fallback if we don't have it in scope
    console.error(`[API:${requestId}] ❌❌❌ EXCEPTION CAUGHT IN API ROUTE ❌❌❌`);
    console.error(`[API:${requestId}] Error type:`, error?.constructor?.name);
    console.error(`[API:${requestId}] Error toString:`, String(error));

    // Extract detailed error information
    let errorMessage = "Generation failed";
    let errorDetails = "";

    if (error instanceof Error) {
      errorMessage = error.message;
      errorDetails = error.stack || "";
      console.error(`[API:${requestId}] Error message:`, errorMessage);
      console.error(`[API:${requestId}] Error stack:`, error.stack);

      // Check for specific error types
      if ("cause" in error && error.cause) {
        console.error(`[API:${requestId}] Error cause:`, error.cause);
        errorDetails += `\nCause: ${JSON.stringify(error.cause)}`;
      }
    }

    // Try to extract more details from Google API errors
    if (error && typeof error === "object") {
      const apiError = error as Record<string, unknown>;
      console.error(`[API:${requestId}] Error object keys:`, Object.keys(apiError));

      if (apiError.status) {
        console.error(`[API:${requestId}] Error status:`, apiError.status);
        errorDetails += `\nStatus: ${apiError.status}`;
      }
      if (apiError.statusText) {
        console.error(`[API:${requestId}] Error statusText:`, apiError.statusText);
        errorDetails += `\nStatusText: ${apiError.statusText}`;
      }
      if (apiError.errorDetails) {
        console.error(`[API:${requestId}] Error errorDetails:`, apiError.errorDetails);
        errorDetails += `\nDetails: ${JSON.stringify(apiError.errorDetails)}`;
      }
      if (apiError.response) {
        try {
          console.error(`[API:${requestId}] Error response:`, apiError.response);
          errorDetails += `\nResponse: ${JSON.stringify(apiError.response)}`;
        } catch {
          errorDetails += `\nResponse: [unable to stringify]`;
        }
      }

      // Log entire error object for debugging
      try {
        console.error(`[API:${requestId}] Full error object:`, JSON.stringify(apiError, null, 2));
      } catch {
        console.error(`[API:${requestId}] Could not stringify full error object`);
      }
    }

    console.error(`[API:${requestId}] Compiled error details:`, errorDetails);

    // Handle rate limiting
    if (errorMessage.includes("429")) {
      console.error(`[API:${requestId}] Rate limit error detected`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: "Rate limit reached. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    console.error(`[API:${requestId}] Returning 500 error response`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: `${errorMessage}${errorDetails ? ` | Details: ${errorDetails.substring(0, 500)}` : ""}`,
      },
      { status: 500 }
    );
  }
}

// Azure FLUX.2-pro generation handler
async function handleAzureFluxGeneration(
  requestId: string,
  prompt: string,
  aspectRatio?: string,
  size?: AzureFluxSize
): Promise<NextResponse<GenerateResponse>> {
  console.log(`[API:${requestId}] Using Azure FLUX.2-pro model`);

  const azureApiKey = process.env.AZURE_API_KEY;

  if (!azureApiKey) {
    console.error(`[API:${requestId}] ❌ No Azure API key configured`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "Azure API key not configured. Add AZURE_API_KEY to .env.local",
      },
      { status: 500 }
    );
  }

  if (!prompt) {
    console.error(`[API:${requestId}] ❌ Validation failed: missing prompt`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "Prompt is required for Azure FLUX generation",
      },
      { status: 400 }
    );
  }

  // Determine size from aspect ratio if not explicitly provided
  let imageSize: AzureFluxSize = size || "1024x1024";
  if (!size && aspectRatio) {
    imageSize = ASPECT_RATIO_TO_SIZE[aspectRatio] || "1024x1024";
  }

  console.log(`[API:${requestId}] Azure FLUX parameters:`);
  console.log(`[API:${requestId}]   - Size: ${imageSize}`);
  console.log(`[API:${requestId}]   - Prompt: ${prompt.substring(0, 100)}...`);

  try {
    console.log(`[API:${requestId}] Calling Azure FLUX API...`);
    const azureStartTime = Date.now();

    const response = await fetch(AZURE_FLUX_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": azureApiKey,
      },
      body: JSON.stringify({
        prompt,
        size: imageSize,
        n: 1,
        model: "FLUX.2-pro",
      }),
    });

    const azureDuration = Date.now() - azureStartTime;
    console.log(`[API:${requestId}] Azure FLUX API call completed in ${azureDuration}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[API:${requestId}] ❌ Azure API error: ${response.status} ${response.statusText}`);
      console.error(`[API:${requestId}] Error body: ${errorText}`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Azure FLUX API error: ${response.status} - ${errorText.substring(0, 200)}`,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`[API:${requestId}] Azure response keys:`, Object.keys(data));

    // Extract base64 image from response
    if (data.data && data.data.length > 0 && data.data[0].b64_json) {
      const base64Image = data.data[0].b64_json;
      const imageSizeKB = (base64Image.length / 1024).toFixed(2);
      console.log(`[API:${requestId}] ✓ Found image in response: ${imageSizeKB}KB base64`);

      const dataUrl = `data:image/png;base64,${base64Image}`;
      const responsePayload = { success: true, image: dataUrl };
      const responseSize = JSON.stringify(responsePayload).length;
      const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);
      console.log(`[API:${requestId}] Total response payload size: ${responseSizeMB}MB`);

      console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning Azure FLUX image ✓✓✓`);

      const jsonResponse = NextResponse.json<GenerateResponse>(responsePayload);
      jsonResponse.headers.set('Content-Type', 'application/json');
      jsonResponse.headers.set('Content-Length', responseSize.toString());

      return jsonResponse;
    }

    // Check for URL-based response
    if (data.data && data.data.length > 0 && data.data[0].url) {
      console.log(`[API:${requestId}] Found URL in response, fetching image...`);
      const imageUrl = data.data[0].url;
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      const dataUrl = `data:image/png;base64,${base64Image}`;
      const responsePayload = { success: true, image: dataUrl };

      console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning Azure FLUX image from URL ✓✓✓`);
      return NextResponse.json<GenerateResponse>(responsePayload);
    }

    console.error(`[API:${requestId}] ❌ No image found in Azure response`);
    console.error(`[API:${requestId}] Full response:`, JSON.stringify(data, null, 2));
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No image in Azure FLUX response",
      },
      { status: 500 }
    );
  } catch (error) {
    console.error(`[API:${requestId}] ❌ Azure FLUX API exception:`, error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: `Azure FLUX generation failed: ${errorMessage}`,
      },
      { status: 500 }
    );
  }
}

// Azure GPT Image generation handler
async function handleAzureGptImageGeneration(
  requestId: string,
  prompt: string,
  aspectRatio?: string,
  gptImageSize?: AzureGptImageSize,
  gptImageQuality?: AzureGptImageQuality
): Promise<NextResponse<GenerateResponse>> {
  console.log(`[API:${requestId}] Using Azure GPT Image model`);

  const azureApiKey = process.env.AZURE_GPT_IMAGE_API_KEY;

  if (!azureApiKey) {
    console.error(`[API:${requestId}] ❌ No Azure GPT Image API key configured`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "Azure GPT Image API key not configured. Add AZURE_GPT_IMAGE_API_KEY to .env.local",
      },
      { status: 500 }
    );
  }

  if (!prompt) {
    console.error(`[API:${requestId}] ❌ Validation failed: missing prompt`);
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "Prompt is required for Azure GPT Image generation",
      },
      { status: 400 }
    );
  }

  // Determine size from aspect ratio if not explicitly provided
  let imageSize: AzureGptImageSize = gptImageSize || "1024x1024";
  if (!gptImageSize && aspectRatio) {
    imageSize = ASPECT_RATIO_TO_GPT_SIZE[aspectRatio] || "1024x1024";
  }

  // Default quality to medium if not specified
  const quality = gptImageQuality || "medium";

  console.log(`[API:${requestId}] Azure GPT Image parameters:`);
  console.log(`[API:${requestId}]   - Size: ${imageSize}`);
  console.log(`[API:${requestId}]   - Quality: ${quality}`);
  console.log(`[API:${requestId}]   - Prompt: ${prompt.substring(0, 100)}...`);

  try {
    console.log(`[API:${requestId}] Calling Azure GPT Image API...`);
    const azureStartTime = Date.now();

    const response = await fetch(AZURE_GPT_IMAGE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${azureApiKey}`,
      },
      body: JSON.stringify({
        prompt,
        size: imageSize,
        quality,
        output_compression: 100,
        output_format: "png",
        n: 1,
        model: "gpt-image-1.5",
      }),
    });

    const azureDuration = Date.now() - azureStartTime;
    console.log(`[API:${requestId}] Azure GPT Image API call completed in ${azureDuration}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[API:${requestId}] ❌ Azure GPT Image API error: ${response.status} ${response.statusText}`);
      console.error(`[API:${requestId}] Error body: ${errorText}`);
      return NextResponse.json<GenerateResponse>(
        {
          success: false,
          error: `Azure GPT Image API error: ${response.status} - ${errorText.substring(0, 200)}`,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log(`[API:${requestId}] Azure GPT Image response keys:`, Object.keys(data));

    // Extract base64 image from response
    if (data.data && data.data.length > 0 && data.data[0].b64_json) {
      const base64Image = data.data[0].b64_json;
      const imageSizeKB = (base64Image.length / 1024).toFixed(2);
      console.log(`[API:${requestId}] ✓ Found image in response: ${imageSizeKB}KB base64`);

      const dataUrl = `data:image/png;base64,${base64Image}`;
      const responsePayload = { success: true, image: dataUrl };
      const responseSize = JSON.stringify(responsePayload).length;
      const responseSizeMB = (responseSize / (1024 * 1024)).toFixed(2);
      console.log(`[API:${requestId}] Total response payload size: ${responseSizeMB}MB`);

      console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning Azure GPT Image ✓✓✓`);

      const jsonResponse = NextResponse.json<GenerateResponse>(responsePayload);
      jsonResponse.headers.set('Content-Type', 'application/json');
      jsonResponse.headers.set('Content-Length', responseSize.toString());

      return jsonResponse;
    }

    // Check for URL-based response
    if (data.data && data.data.length > 0 && data.data[0].url) {
      console.log(`[API:${requestId}] Found URL in response, fetching image...`);
      const imageUrl = data.data[0].url;
      const imageResponse = await fetch(imageUrl);
      const imageBuffer = await imageResponse.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString('base64');

      const dataUrl = `data:image/png;base64,${base64Image}`;
      const responsePayload = { success: true, image: dataUrl };

      console.log(`[API:${requestId}] ✓✓✓ SUCCESS - Returning Azure GPT Image from URL ✓✓✓`);
      return NextResponse.json<GenerateResponse>(responsePayload);
    }

    console.error(`[API:${requestId}] ❌ No image found in Azure GPT Image response`);
    console.error(`[API:${requestId}] Full response:`, JSON.stringify(data, null, 2));
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: "No image in Azure GPT Image response",
      },
      { status: 500 }
    );
  } catch (error) {
    console.error(`[API:${requestId}] ❌ Azure GPT Image API exception:`, error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json<GenerateResponse>(
      {
        success: false,
        error: `Azure GPT Image generation failed: ${errorMessage}`,
      },
      { status: 500 }
    );
  }
}
