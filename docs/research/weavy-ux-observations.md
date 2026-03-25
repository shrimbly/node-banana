# Weavy UX Observations

Dokumentation af UX pain points og åbenlyse use cases observeret under opbygning af MX5 film-workflows i Weavy. Formål: evaluere om en Weavy-klon med bedre UX er levedygtig.

---

## UX Pain Points

### P1: Ingen import/eksport af workflows
**Severity:** Kritisk
**Context:** Der er ingen JSON/YAML import/eksport. Hvert workflow skal bygges manuelt node-for-node. Det betyder at man ikke kan dele, versionere, eller genskabe workflows.
**Impact:** Umuligt at versionere workflows i git. Umuligt at dele workflows som "templates". Umuligt at lave backup. Hvis du ved et uheld sletter et workflow, er det væk.
**Klon-mulighed:** Import/eksport af workflows som JSON. Git-venlige filer. Template marketplace.

### P2: HEIC-filer ikke understøttet
**Severity:** Medium
**Context:** iPhone tager billeder i HEIC-format. Weavy kræver JPEG/PNG. Brugeren skal konvertere manuelt før upload.
**Impact:** Ekstra trin i workflowet. Ikke-tekniske brugere ved ikke hvad HEIC er eller hvordan de konverterer.
**Klon-mulighed:** Auto-konvertering ved upload. Accept af alle billedformater (HEIC, WebP, AVIF, RAW).

### P3: Kun 2 image-porte på LLM-noder
**Severity:** Medium
**Context:** "Run Any LLM" noden har Image 1 og Image 2 porte. Hvis du vil analysere 4+ reference-billeder, skal du først lave en Compositor → 2×2 grid → feed som ét billede.
**Impact:** Ekstra node + manuelt layout-arbejde bare for at omgå en portbegrænsning. Tilføjer kompleksitet til simple workflows.
**Klon-mulighed:** Dynamisk antal image-inputs på LLM-noder. "Add image input" knap. Automatisk grid-composition som option.

### P4: Ingen LLM-noder efter Array
**Severity:** Høj
**Context:** Weavys vigtigste arkitekturelle begrænsning: du kan ikke placere en LLM-node downstream fra en Array-node. Al tekstbehandling skal ske FØR array-splittet.
**Impact:** Umuligt at lave per-item kvalitetskontrol, per-item prompt-optimering, eller per-item tilpasning efter splittet. Tvinger "batch-tænkning" ind i ét LLM-node-output.
**Klon-mulighed:** Tillad LLM-noder efter Array. Hvert array-element processeres individuelt. Map-reduce pattern.

### P5: Deep Thinking forurener output
**Severity:** Høj
**Context:** Når "Deep Thinking" er aktiveret på en LLM-node, inkluderer outputtet [Thinking]-tags der propagerer downstream og ødelægger generation prompts.
**Impact:** Brugere der tænder Deep Thinking i god tro (det lyder som en forbedring!) får ødelagt hele workflowet. Ingen advarsel. Svært at debugge.
**Klon-mulighed:** Thinking-tags strippes automatisk fra output. Separat "reasoning" output-port. Eller slet ingen Deep Thinking toggle — brug altid den bedste inferens under hjelmen.

### P6: Uklart hvornår Array → Generation kræver Text Iterator
**Severity:** Medium
**Context:** Array-output kan IKKE forbindes direkte til en generation-nodes prompt-input (type mismatch / rød port). Man skal indsætte en Text Iterator eller List Selector imellem.
**Impact:** Nybegyndere forbinder Array → Nanobanana, får en fejl, og ved ikke hvorfor. Ingen error message der forklarer løsningen.
**Klon-mulighed:** Automatisk type-konvertering. Eller i det mindste en klar fejlbesked: "Array output must go through a Text Iterator before reaching a generation node."

### P7: Separator-forvirring
**Severity:** Lav-Medium
**Context:** Array-noden kræver en separator-karakter (^, §, †). Brugeren skal sikre at separatoren aldrig forekommer i det normale prompt-output. Hvis LLM'en bruger ^ i teksten, bryder array-splittet.
**Impact:** Svært at debugge. Output ser fint ud i preview men splitter forkert. Og * (den mest intuitive separator) kolliderer med markdown bold.
**Klon-mulighed:** Struktureret output (JSON array) i stedet for separator-baseret parsing. Eller "smart split" der forstår kontekst.

---

## Åbenlyse Use Cases

### U1: Product Photography Pipeline
**Target:** E-commerce, DTC brands
**Flow:** Upload 1-3 produktfotos → analysér → generer 9 vinkler (contact sheet) → generer lifestyle-scener → eksportér til webshop
**Value prop:** Professionelle produktfotos uden fotograf. Fra telefonfoto til webshop-klar i 10 minutter.
**Marked:** Shopify merchants, Amazon sellers, små DTC brands der ikke har budget til professionel fotografi.

### U2: Brand Campaign Generator
**Target:** Marketing teams, creative agencies
**Flow:** Upload brand guidelines + produktfotos → brand DNA extraction → campaign visual generation → multi-format eksport (social, web, print)
**Value prop:** On-brand kampagnebilleder på minutter, ikke uger. Konsistent æstetik across channels.

### U3: Character Consistency Engine
**Target:** Content creators, filmmakers, game studios
**Flow:** Upload karakter-reference → character DNA → "infinite reshoot" → konsistente poses/scenes/outfits
**Value prop:** Konsistent karakter uden LoRA-training. Ændre tøj, scene, pose — bevar ansigt og krop.

### U4: Short Film / Music Video Pre-viz
**Target:** Filmmakers, musikere, indie productions
**Flow:** Storyboard/shotlist → keyframe stills → video generation → rough cut
**Value prop:** Pre-visualisering af en hel film for prisen af en pizza. Test idéer før du hyrer crew.

### U5: Real Estate / Architecture Visualization
**Target:** Ejendomsmæglere, arkitekter
**Flow:** Upload eksisterende fotos → style transfer → season variations → twilight shots → social-ready
**Value prop:** Twilight-fotos uden fotograf. Vinter→sommer transformation. Virtual staging.

### U6: Fashion Lookbook Generator
**Target:** Fashion brands, stylists
**Flow:** Upload tøj/accessories → model generation → pose variations → lookbook layout
**Value prop:** Komplet lookbook fra flatlay-fotos. Ingen model, ingen studio, ingen fotograf.

---

## Overordnet UX-Vurdering

**Weavy er kraftfuldt men uforståeligt for nybegyndere.** Det kræver dyb forståelse af AI model-adfærd, prompt engineering, og node-baseret tænkning for at opnå gode resultater. Dokumentationen er sparsom. Fejlbeskeder er kryptiske.

**En klon bør fokusere på:**
1. **Guided workflows** — templates der guider brugeren igennem "Product Photography", "Campaign Generator" etc. med forudfyldte system prompts og node-opsætning
2. **Fejltolerance** — auto-konvertering, type-matching, separator-håndtering under hjelmen
3. **Versionering** — git-venlige workflow-filer, undo/redo, workflow-templates
4. **Onboarding** — "build your first workflow in 5 minutes" wizard
5. **Debugging** — klar visning af hvad hvert node producerer, diff mellem input og output
