export function pageCellMassBootstrap(initialSettings = {}, pageWindow = globalThis) {
  const win = pageWindow || globalThis;
  const host = String(win.location?.hostname || '').toLowerCase();
  if (host && host !== 'custom.client.blobgame.io' && host !== 'blobgame.io') {
    return false;
  }

  if (win.__blobioCellMassInstalled) {
    win.__blobioCellMassRefresh?.(initialSettings);
    return true;
  }

  const SCRIPT_VERSION = '0.1.26';
  const CELL_MASS_SNAPSHOT_KEY = 'blobio.settings.cellMass.snapshot';
  const CELL_MASS_COOKIE_NAME = 'blobioCellMass';
  const STORAGE_BRIDGE_SOURCE = 'BlobioExtensionStorageBridge';
  const CACHE_SCRIPT_RE = /\/html\/[a-f0-9]{32}\.cache\.js(?:[?#].*)?$/i;
  const DRAW_HOOK_NAME = 'BlobioCellMassDraw';
  const PATCH_MARKER = 'BlobioCellMassDraw';
  const MIN_RENDER_SIZE = 13;
  const MAX_LABEL_WIDTH = 0.9;
  const MAX_LABEL_HEIGHT = 0.32;
  const PRIMARY_MAX_LABEL_HEIGHT = 0.42;
  const VISIBLE_PLAYER_MAX_AGE_MS = 2000;
  const RADAR_PLAYER_MAX_AGE_MS = 120;
  const VISIBLE_PLAYER_PRUNE_INTERVAL_MS = 250;
  const VISIBLE_PLAYER_MAX_ENTRIES = 320;
  const VISIBLE_PLAYER_SORT_CACHE_MS = 45;
  const RADAR_GROUP_CACHE_MS = 45;
  const LABEL_BUDGET_WINDOW_MS = 16;
  const LABEL_BUDGET_MAX_CALLS = 120;
  const LABEL_BUDGET_MAX_SMALL_LABELS = 52;
  const LABEL_BUDGET_MAX_PROTECTED_LABELS = 64;
  const LABEL_BUDGET_SMALL_MASS = 1800;
  const LABEL_BUDGET_PROTECTED_SMALL_MASS = 3200;
  const RADAR_ANCHOR_SMOOTHING = 0.22;
  const RADAR_ANCHOR_SPLIT_SMOOTHING = 0.14;
  const PLAYER_ARROW_CANVAS_ID = 'blobio-visible-player-arrows';
  const PLAYER_ARROW_TOGGLE_ID = 'blobio-visible-player-toggle';
  const PLAYER_ANCHOR_TOGGLE_ID = 'blobio-visible-player-anchor';

  let settings = normalizeSettings(initialSettings);
  let lastCacheSweep = 0;
  let arrowFrame = 0;
  let lastVisiblePlayerPrune = 0;
  let visiblePlayersSnapshot = [];
  let visiblePlayersSnapshotAt = 0;
  let radarGroupSnapshot = null;
  let radarGroupSnapshotAt = 0;
  let smoothedRadarAnchor = null;
  const labelBudget = {
    windowStart: 0,
    calls: 0,
    smallLabels: 0,
    protectedLabels: 0,
  };

  const labelCache = new Map();
  const visiblePlayers = new Map();
  const state = {
    installed: true,
    version: SCRIPT_VERSION,
    startedAt: Date.now(),
    settings,
    seenCacheScripts: 0,
    wrappedCallback: false,
    patchedChunks: 0,
    lastPatchResult: null,
    counters: {
      drawHookCalls: 0,
      labelsDrawn: 0,
      labelUpdates: 0,
      cacheHits: 0,
      hiddenBySetting: 0,
      hiddenByThreshold: 0,
      hiddenBySmartLimit: 0,
      hiddenByFrameBudget: 0,
      primaryLabels: 0,
      visiblePlayerCells: 0,
    },
    samples: [],
    lastLabel: null,
    lastDrawCapture: null,
    arrowOverlay: null,
    lastRadar: null,
    errors: [],
  };

  win.__blobioCellMassInstalled = true;
  win.__blobioCellMassState = state;
  win[DRAW_HOOK_NAME] = drawCellMassLabel;
  win.__blobioCellMassRefresh = refreshSettings;
  win.__BlobioCellMassDebug = debugReport;
  win.BlobioCellMassDebug = debugReport;
  win.BlobioShowMassDebug = debugReport;
  win.blobioCellMassDebug = debugReport;
  win.BlobioVisiblePlayers = getVisiblePlayers;
  win.__BlobioVisiblePlayers = getVisiblePlayers;
  win.BlobioPlayerArrows = setPlayerArrowsEnabled;
  win.__BlobioPlayerArrows = setPlayerArrowsEnabled;
  win.BlobioRadarAnchorName = setPlayerRadarAnchorName;
  win.__BlobioRadarAnchorName = setPlayerRadarAnchorName;
  win.__blobioCellMassCaptureDraw = captureDrawState;

  if (win.__BLOBIO_CELL_MASS_TEST__) {
    win.__BlobioCellMassTestApi = {
      captureDrawState,
      drawCellMassLabel,
      formatMass,
      getFitScale,
      normalizeSettings,
      patchGameBundle,
      refreshSettings,
    };
  }

  installGameScriptPatch();
  installPlayerArrowOverlay();
  return true;

  function refreshSettings(nextSettings = {}) {
    const previous = settings;
    settings = normalizeSettings({
      ...settings,
      ...(nextSettings || {}),
    });
    state.settings = settings;

    if (
      previous.compact !== settings.compact
      || previous.updateDelayMs !== settings.updateDelayMs
    ) {
      labelCache.clear();
    }

    return settings;
  }

  function drawCellMassLabel(cellId, mass, rawSize, renderSize, cellSize, name, nameDrawn, nameScale, explicitFitScale, totalMass, worldX, worldY, cellType, isOwnCell, isFriendCell, projectionMatrix) {
    state.counters.drawHookCalls += 1;

    if (!settings.enabled) {
      state.counters.hiddenBySetting += 1;
      return null;
    }

    const safeMass = Math.max(0, Number(mass) || 0);
    const safeRawSize = Number(rawSize) || 0;
    const safeRenderSize = Number(renderSize) || safeRawSize;
    const safeName = String(name || '').trim();
    if (!safeName) {
      state.counters.hiddenByThreshold += 1;
      return null;
    }

    if (safeMass <= 0 || Math.max(safeRawSize, safeRenderSize) < MIN_RENDER_SIZE) {
      state.counters.hiddenByThreshold += 1;
      return null;
    }

    const drawInfo = getCellDrawInfo(worldX, worldY, Math.max(safeRenderSize, safeRawSize) / 2, cellSize, projectionMatrix);
    rememberVisiblePlayer(cellId, safeMass, safeRawSize, safeRenderSize, cellSize, safeName, worldX, worldY, cellType, isOwnCell, isFriendCell, drawInfo);

    const autoMinMass = settings.smartRendering ? getAutoMinMass(totalMass) : 0;
    if (autoMinMass > 0 && safeMass <= autoMinMass) {
      state.counters.hiddenBySmartLimit += 1;
      return null;
    }

    const primary = isPrimaryLabel(safeMass, safeRawSize, safeRenderSize, totalMass);
    if (shouldSkipLabelForFrameBudget(safeMass, primary, isOwnCell, isFriendCell)) {
      state.counters.hiddenByFrameBudget += 1;
      return null;
    }

    const now = Date.now();
    sweepLabelCache(now);
    const textEntry = readMassText(cellId, safeMass, now);
    if (!textEntry.text) {
      return null;
    }

    const fitScale = Number(explicitFitScale) > 0
      ? Number(explicitFitScale)
      : getFitScale(textEntry.text, safeName, nameScale, safeRenderSize);
    let scale = clampNumber(fitScale * settings.textScale, 0.001, 1.4, settings.textScale);

    if (primary) {
      scale = Math.max(scale, readableScaleFloor(safeRawSize, safeRenderSize));
      state.counters.primaryLabels += 1;
    }

    const result = {
      text: textEntry.text,
      scale,
      offset: settings.yOffset,
      lineGap: settings.nameGap,
      maxWidth: MAX_LABEL_WIDTH,
      maxHeight: primary ? PRIMARY_MAX_LABEL_HEIGHT : MAX_LABEL_HEIGHT,
      cached: textEntry.cached,
      primary,
    };

    state.counters.labelsDrawn += 1;
    state.lastLabel = cloneLabelResult(cellId, safeMass, result);
    rememberSample(cellId, safeMass, safeRawSize, safeRenderSize, cellSize, safeName, Boolean(nameDrawn), result);
    return result;
  }

  function rememberVisiblePlayer(cellId, mass, rawSize, renderSize, cellSize, name, worldX, worldY, cellType, isOwnCell, isFriendCell, drawInfo) {
    const key = String(cellId ?? `${name}:${Math.round(Number(worldX) || 0)}:${Math.round(Number(worldY) || 0)}`);
    const now = Date.now();
    const previous = visiblePlayers.get(key);
    const projected = drawInfo?.projected ? drawInfo : null;
    const screenX = projected ? roundNumber(projected.x) : roundNumber(previous?.screenX ?? worldX);
    const screenY = projected ? roundNumber(projected.y) : roundNumber(previous?.screenY ?? worldY);
    visiblePlayers.set(key, {
      ...(previous || {}),
      at: now,
      cellId: String(cellId ?? ''),
      name: String(name || '').slice(0, 48),
      mass: Math.round(Number(mass) || 0),
      rawSize: roundNumber(rawSize),
      renderSize: roundNumber(renderSize),
      cellSize: roundNumber(cellSize),
      x: roundNumber(worldX),
      y: roundNumber(worldY),
      screenAt: now,
      screenX,
      screenY,
      projected: Boolean(projected),
      projectionMode: projected ? 'matrix' : 'world',
      type: Number.isFinite(Number(cellType)) ? Number(cellType) : null,
      own: Boolean(isOwnCell),
      friend: Boolean(isFriendCell),
    });
    visiblePlayersSnapshotAt = 0;
    state.counters.visiblePlayerCells += 1;
    if (now - lastVisiblePlayerPrune >= VISIBLE_PLAYER_PRUNE_INTERVAL_MS || visiblePlayers.size > VISIBLE_PLAYER_MAX_ENTRIES) {
      pruneVisiblePlayers(now);
    }
  }

  function pruneVisiblePlayers(now = Date.now()) {
    let changed = false;
    for (const [key, player] of visiblePlayers) {
      if (now - player.at > VISIBLE_PLAYER_MAX_AGE_MS) {
        visiblePlayers.delete(key);
        changed = true;
      }
    }

    if (visiblePlayers.size > VISIBLE_PLAYER_MAX_ENTRIES) {
      const removable = [...visiblePlayers.entries()]
        .filter(([, player]) => !player.own)
        .sort(([, left], [, right]) => {
          const massDiff = (Number(left.mass) || 0) - (Number(right.mass) || 0);
          return massDiff || (Number(left.at) || 0) - (Number(right.at) || 0);
        });

      for (const [key] of removable) {
        if (visiblePlayers.size <= VISIBLE_PLAYER_MAX_ENTRIES) {
          break;
        }
        visiblePlayers.delete(key);
        changed = true;
      }
    }

    lastVisiblePlayerPrune = now;
    if (changed) {
      visiblePlayersSnapshotAt = 0;
      radarGroupSnapshotAt = 0;
    }
  }

  function getVisiblePlayers() {
    const now = Date.now();
    pruneVisiblePlayers(now);
    if (visiblePlayersSnapshotAt && now - visiblePlayersSnapshotAt <= VISIBLE_PLAYER_SORT_CACHE_MS) {
      return visiblePlayersSnapshot.slice();
    }

    visiblePlayersSnapshot = [...visiblePlayers.values()]
      .sort((left, right) => right.mass - left.mass || String(left.name).localeCompare(String(right.name)));
    visiblePlayersSnapshotAt = now;
    return visiblePlayersSnapshot.slice();
  }

  function setPlayerArrowsEnabled(enabled = true) {
    settings = normalizeSettings({
      ...settings,
      playerArrows: Boolean(enabled),
    });
    state.settings = settings;
    persistSettings();
    updatePlayerArrowToggle();
    updatePlayerAnchorToggle();
    if (settings.playerArrows) {
      installPlayerArrowOverlay();
    }
    return settings.playerArrows;
  }

  function setPlayerRadarAnchorName(name = '') {
    settings = normalizeSettings({
      ...settings,
      radarAnchorName: normalizeRadarAnchorName(name),
    });
    state.settings = settings;
    persistSettings();
    updatePlayerAnchorToggle();
    if (settings.playerArrows) {
      installPlayerArrowOverlay();
    }
    return settings.radarAnchorName;
  }

  function readMassText(cellId, mass, now) {
    const key = String(cellId ?? `mass-${mass}`);
    const cached = labelCache.get(key);
    if (cached && settings.updateDelayMs > 0 && now - cached.updatedAt < settings.updateDelayMs) {
      cached.lastSeen = now;
      state.counters.cacheHits += 1;
      return { text: cached.text, cached: true };
    }

    const text = formatMass(mass);
    labelCache.set(key, {
      text,
      updatedAt: now,
      lastSeen: now,
    });
    state.counters.labelUpdates += 1;
    return { text, cached: false };
  }

  function formatMass(value) {
    const mass = Math.max(0, Number(value) || 0);
    if (!settings.compact) {
      return String(Math.round(mass));
    }

    if (mass >= 1000000) {
      return `${trimNumber(mass / 1000000)}m`;
    }

    if (mass >= 1000) {
      return `${trimNumber(mass / 1000)}k`;
    }

    return String(Math.round(mass));
  }

  function trimNumber(value) {
    const rounded = Math.round(value * 10) / 10;
    return rounded % 1 === 0 ? String(rounded | 0) : rounded.toFixed(1);
  }

  function getAutoMinMass(totalMass) {
    const total = Number(totalMass) || 0;
    if (total > 15000) {
      return 500;
    }
    if (total >= 8000) {
      return 200;
    }
    if (total > 2000) {
      return 40;
    }
    return 0;
  }

  function shouldSkipLabelForFrameBudget(mass, primary, isOwnCell, isFriendCell) {
    if (!settings.smartRendering) {
      return false;
    }

    const now = getPerfNow();
    if (!labelBudget.windowStart || now - labelBudget.windowStart > LABEL_BUDGET_WINDOW_MS) {
      labelBudget.windowStart = now;
      labelBudget.calls = 0;
      labelBudget.smallLabels = 0;
      labelBudget.protectedLabels = 0;
    }

    labelBudget.calls += 1;
    const safeMass = Number(mass) || 0;
    const protectedLabel = primary || isOwnCell || isFriendCell;

    if (protectedLabel) {
      labelBudget.protectedLabels += 1;
      return labelBudget.protectedLabels > LABEL_BUDGET_MAX_PROTECTED_LABELS
        && safeMass < LABEL_BUDGET_PROTECTED_SMALL_MASS;
    }

    if (safeMass >= LABEL_BUDGET_SMALL_MASS) {
      return false;
    }

    labelBudget.smallLabels += 1;
    return labelBudget.calls > LABEL_BUDGET_MAX_CALLS
      || labelBudget.smallLabels > LABEL_BUDGET_MAX_SMALL_LABELS;
  }

  function getFitScale(text, name, nameScale, renderSize) {
    const textLength = Math.max(String(text || '').length, 3);
    const nameLength = Math.max(String(name || '').length, 3);
    const widestLength = Math.max(textLength, nameLength);
    const scale = Number(nameScale);

    if (Number.isFinite(scale) && scale > 0) {
      return scale * (nameLength / widestLength);
    }

    return Math.max(0.001, Number(renderSize) / (widestLength * 80));
  }

  function isPrimaryLabel(mass, rawSize, renderSize, totalMass) {
    if (!settings.emphasizeBiggest) {
      return false;
    }

    const total = Number(totalMass) || 0;
    const share = total > 0 ? mass / total : 0;
    return share >= 0.18 || Math.max(Number(rawSize) || 0, Number(renderSize) || 0) >= 80;
  }

  function readableScaleFloor(rawSize, renderSize) {
    const size = Math.max(Number(rawSize) || 0, Number(renderSize) || 0);
    if (size >= 150) {
      return 0.26;
    }
    if (size >= 95) {
      return 0.2;
    }
    return 0.18;
  }

  function cloneLabelResult(cellId, mass, result) {
    return {
      at: Date.now(),
      cellId: String(cellId ?? ''),
      mass: Math.round(mass * 10) / 10,
      text: result.text,
      scale: roundNumber(result.scale),
      offset: roundNumber(result.offset),
      primary: Boolean(result.primary),
      cached: Boolean(result.cached),
    };
  }

  function captureDrawState(cellId, label, nativeColor, x, y) {
    const native = cloneRendererColor(nativeColor);
    rememberVisiblePlayerScreen(cellId, x, y);
    state.lastDrawCapture = {
      at: Date.now(),
      cellId: String(cellId ?? ''),
      text: typeof label?.text === 'string' ? label.text : '',
      scale: roundNumber(label?.scale),
      x: roundNumber(x),
      y: roundNumber(y),
      rendererMode: 'native-text-color',
      appliedColor: native,
      nativeColor: native,
    };
    return state.lastDrawCapture;
  }

  function rememberVisiblePlayerScreen(cellId, x, y) {
    const key = String(cellId ?? '');
    const player = visiblePlayers.get(key);
    if (!player) {
      return;
    }

    player.labelAt = Date.now();
    player.labelX = roundNumber(x);
    player.labelY = roundNumber(y);
  }

  function installPlayerArrowOverlay() {
    if (arrowFrame) {
      return;
    }

    if (!win.document?.body) {
      win.setTimeout?.(installPlayerArrowOverlay, 250);
      return;
    }

    installPlayerArrowStyle();
    ensurePlayerArrowToggle();
    ensurePlayerAnchorToggle();
    const draw = () => {
      arrowFrame = win.requestAnimationFrame?.(draw) || 0;
      try {
        drawPlayerArrows();
      } catch (error) {
        rememberError(`Player arrows failed: ${getErrorMessage(error)}`);
      }
    };
    draw();
  }

  function drawPlayerArrows() {
    const doc = win.document;
    const targetCanvas = findGameCanvas();
    if (!targetCanvas || !settings.enabled || !settings.playerArrows) {
      clearPlayerArrowOverlay();
      return;
    }

    const overlay = ensurePlayerArrowOverlay(targetCanvas);
    const context = overlay?.getContext?.('2d');
    if (!overlay || !context) {
      return;
    }

    const rect = targetCanvas.getBoundingClientRect?.();
    if (!rect || rect.width <= 1 || rect.height <= 1) {
      clearPlayerArrowOverlay();
      return;
    }

    alignPlayerArrowOverlay(overlay, rect);
    const dpr = getDevicePixelRatio();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const now = Date.now();
    const radarPlayers = getRadarPlayers(now);
    const freshPlayers = radarPlayers.freshPlayers;
    const allPlayers = radarPlayers.groupedPlayers;
    const rawAnchor = getRadarAnchor(freshPlayers, allPlayers, rect);
    const anchor = smoothRadarAnchor(rawAnchor, now, rect);
    const anchorName = normalizeRadarAnchorName(anchor.name);
    const players = allPlayers
      .filter((player) => !player.own)
      .filter((player) => normalizeRadarAnchorName(player.name) !== anchorName)
      .slice(0, 20);
    const arrowRadius = clampNumber(Math.min(rect.width, rect.height) * 0.18, 70, 150, 105);
    const centerX = clampNumber(anchor.x, arrowRadius + 18, rect.width - arrowRadius - 18, rect.width / 2);
    const centerY = clampNumber(anchor.y, arrowRadius + 18, rect.height - arrowRadius - 18, rect.height / 2);

    drawPlayerArrowRing(context, centerX, centerY, arrowRadius);
    for (const player of players) {
      const delta = getPlayerDirectionDelta(player, anchor, rect);
      drawPlayerDirectionArrow(context, centerX, centerY, arrowRadius, delta.x, delta.y, player);
    }

    state.lastRadar = {
      at: now,
      mode: 'circle-arrows',
      centerX: roundNumber(centerX),
      centerY: roundNumber(centerY),
      radius: roundNumber(arrowRadius),
      anchor,
      lockedAnchorName: settings.radarAnchorName,
      players: players.length,
      sourceCells: freshPlayers.length,
    };

    if (!doc.getElementById?.(PLAYER_ARROW_CANVAS_ID)) {
      state.arrowOverlay = null;
    }
  }

  function getRadarAnchor(freshPlayers, groupedPlayers, rect) {
    const lockedName = normalizeRadarAnchorName(settings.radarAnchorName);
    if (lockedName) {
      const locked = groupedPlayers.find((player) => normalizeRadarAnchorName(player.name) === lockedName);
      if (locked) {
        return createRadarAnchor([locked], rect, 'locked-name');
      }
    }

    const ownCells = freshPlayers.filter((player) => player.own);
    const anchorCells = ownCells.length ? ownCells : chooseFallbackAnchorCells(freshPlayers);
    return createRadarAnchor(anchorCells, rect, ownCells.length ? 'game-own-cell' : 'largest-visible-cell');
  }

  function createRadarAnchor(anchorCells, rect, anchorType) {
    if (!anchorCells.length) {
      return {
        x: rect.width / 2,
        y: rect.height / 2,
        worldX: null,
        worldY: null,
        projected: true,
        anchor: 'screen-center',
      };
    }

    let totalMass = 0;
    let weightedX = 0;
    let weightedY = 0;
    let weightedWorldX = 0;
    let weightedWorldY = 0;
    let projectedWeight = 0;
    let sourceCells = 0;
    let biggest = anchorCells[0] || null;
    for (const player of anchorCells) {
      const weight = Math.max(1, Number(player.mass) || 1);
      totalMass += weight;
      sourceCells += Math.max(1, Number(player.splitCells) || 1);
      weightedX += Number(player.screenX) * weight;
      weightedY += Number(player.screenY) * weight;
      weightedWorldX += Number(player.x) * weight;
      weightedWorldY += Number(player.y) * weight;
      if (player.projected) {
        projectedWeight += weight;
      }
      if ((Number(player.mass) || 0) > (Number(biggest?.mass) || 0)) {
        biggest = player;
      }
    }

    return {
      x: clampNumber(weightedX / totalMass, 24, rect.width - 24, rect.width / 2),
      y: clampNumber(weightedY / totalMass, 24, rect.height - 24, rect.height / 2),
      worldX: roundNumber(weightedWorldX / totalMass),
      worldY: roundNumber(weightedWorldY / totalMass),
      projected: projectedWeight > 0,
      anchor: anchorType,
      name: String(biggest?.name || ''),
      mass: Math.round(Number(biggest?.mass) || 0),
      sourceCells,
    };
  }

  function smoothRadarAnchor(anchor, now, rect) {
    const key = `${anchor.anchor}:${normalizeRadarAnchorName(anchor.name)}`;
    const anchorX = Number(anchor.x);
    const anchorY = Number(anchor.y);
    if (!Number.isFinite(anchorX) || !Number.isFinite(anchorY)) {
      smoothedRadarAnchor = null;
      return anchor;
    }

    const resetDistance = Math.max(220, Math.min(Number(rect?.width) || 0, Number(rect?.height) || 0) * 0.55);
    const previous = smoothedRadarAnchor;
    const previousIsValid = previous
      && previous.key === key
      && now - previous.at < 1000
      && Number.isFinite(Number(previous.x))
      && Number.isFinite(Number(previous.y));
    const distance = previousIsValid ? Math.hypot(anchorX - previous.x, anchorY - previous.y) : Infinity;
    if (!previousIsValid || distance > resetDistance) {
      smoothedRadarAnchor = {
        key,
        at: now,
        x: anchorX,
        y: anchorY,
        worldX: Number(anchor.worldX),
        worldY: Number(anchor.worldY),
      };
      return anchor;
    }

    const smoothing = Number(anchor.sourceCells) > 8 ? RADAR_ANCHOR_SPLIT_SMOOTHING : RADAR_ANCHOR_SMOOTHING;
    const nextX = lerpNumber(previous.x, anchorX, smoothing);
    const nextY = lerpNumber(previous.y, anchorY, smoothing);
    const nextWorldX = Number.isFinite(Number(anchor.worldX))
      ? lerpNumber(previous.worldX, Number(anchor.worldX), smoothing)
      : anchor.worldX;
    const nextWorldY = Number.isFinite(Number(anchor.worldY))
      ? lerpNumber(previous.worldY, Number(anchor.worldY), smoothing)
      : anchor.worldY;

    smoothedRadarAnchor = {
      key,
      at: now,
      x: nextX,
      y: nextY,
      worldX: nextWorldX,
      worldY: nextWorldY,
    };

    return {
      ...anchor,
      x: nextX,
      y: nextY,
      worldX: Number.isFinite(Number(nextWorldX)) ? roundNumber(nextWorldX) : anchor.worldX,
      worldY: Number.isFinite(Number(nextWorldY)) ? roundNumber(nextWorldY) : anchor.worldY,
      smoothed: true,
    };
  }

  function chooseFallbackAnchorCells(freshPlayers) {
    const biggest = freshPlayers
      .slice()
      .sort((left, right) => (Number(right.mass) || 0) - (Number(left.mass) || 0))[0];
    return biggest ? [biggest] : [];
  }

  function getRadarPlayers(now = Date.now()) {
    if (radarGroupSnapshot && now - radarGroupSnapshotAt <= RADAR_GROUP_CACHE_MS) {
      return radarGroupSnapshot;
    }

    const freshPlayers = getVisiblePlayers()
      .filter((player) => player.screenAt && now - player.screenAt <= RADAR_PLAYER_MAX_AGE_MS);
    const groupedPlayers = groupRadarPlayers(freshPlayers);
    radarGroupSnapshot = { freshPlayers, groupedPlayers };
    radarGroupSnapshotAt = now;
    return radarGroupSnapshot;
  }

  function groupRadarPlayers(players) {
    const grouped = new Map();
    for (const player of players) {
      const key = String(player.name || player.cellId || '').trim().toLowerCase();
      if (!key) {
        continue;
      }

      const mass = Math.max(1, Number(player.mass) || 1);
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          ...player,
          mass,
          splitCells: 1,
          weightedScreenX: Number(player.screenX) * mass,
          weightedScreenY: Number(player.screenY) * mass,
          weightedWorldX: Number(player.x) * mass,
          weightedWorldY: Number(player.y) * mass,
          projectedWeight: player.projected ? mass : 0,
          primaryMass: mass,
          totalWeight: mass,
        });
        continue;
      }

      existing.mass += mass;
      existing.splitCells += 1;
      existing.friend = existing.friend || player.friend;
      existing.weightedScreenX += Number(player.screenX) * mass;
      existing.weightedScreenY += Number(player.screenY) * mass;
      existing.weightedWorldX += Number(player.x) * mass;
      existing.weightedWorldY += Number(player.y) * mass;
      if (player.projected) {
        existing.projectedWeight += mass;
      }
      existing.totalWeight += mass;
      if (mass > (Number(existing.primaryMass) || 0)) {
        existing.cellId = player.cellId;
        existing.primaryMass = mass;
      }
    }

    return [...grouped.values()]
      .map((player) => ({
        ...player,
        mass: Math.round(player.mass),
        screenX: player.weightedScreenX / player.totalWeight,
        screenY: player.weightedScreenY / player.totalWeight,
        x: player.weightedWorldX / player.totalWeight,
        y: player.weightedWorldY / player.totalWeight,
        projected: player.projectedWeight > 0,
      }))
      .sort((left, right) => right.mass - left.mass || String(left.name).localeCompare(String(right.name)));
  }

  function getPlayerDirectionDelta(player, anchor, rect) {
    if (player.projected && anchor.projected) {
      return {
        x: Number(player.screenX) - Number(anchor.x),
        y: Number(player.screenY) - Number(anchor.y),
      };
    }

    if (Number.isFinite(Number(anchor.worldX)) && Number.isFinite(Number(anchor.worldY))) {
      return {
        x: Number(player.x) - Number(anchor.worldX),
        y: Number(player.y) - Number(anchor.worldY),
      };
    }

    return {
      x: Number(player.screenX) - rect.width / 2,
      y: Number(player.screenY) - rect.height / 2,
    };
  }

  function drawPlayerArrowRing(context, centerX, centerY, radius) {
    context.save();
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    context.fillStyle = 'rgba(0, 0, 0, 0.1)';
    context.shadowColor = 'rgba(0, 0, 0, 0.35)';
    context.shadowBlur = 6;
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.beginPath();
    context.arc(centerX, centerY, 4, 0, Math.PI * 2);
    context.fillStyle = 'rgba(255, 48, 48, 0.96)';
    context.fill();
    context.restore();
  }

  function drawPlayerDirectionArrow(context, centerX, centerY, radius, dx, dy, player) {
    const distance = Math.hypot(dx, dy);
    if (!Number.isFinite(distance) || distance < 40) {
      return;
    }

    const angle = Math.atan2(dy, dx);
    const arrowX = centerX + Math.cos(angle) * radius;
    const arrowY = centerY + Math.sin(angle) * radius;
    const size = clampNumber(Math.sqrt(Math.max(1, Number(player.mass) || 1)) / 4.6, 8, 18, 11);
    const label = `${String(player.name || '').slice(0, 14)} ${formatMass(player.mass)}`.trim();

    context.save();
    context.translate(arrowX, arrowY);
    context.rotate(angle);
    context.shadowColor = 'rgba(0, 0, 0, 0.6)';
    context.shadowBlur = 6;
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(0, 0, 0, 0.74)';
    context.fillStyle = player.friend ? 'rgba(80, 220, 130, 0.95)' : 'rgba(255, 220, 86, 0.96)';
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(size, 0);
    context.lineTo(-size * 0.78, -size * 0.62);
    context.lineTo(-size * 0.44, 0);
    context.lineTo(-size * 0.78, size * 0.62);
    context.closePath();
    context.stroke();
    context.fill();
    context.restore();

    context.save();
    context.font = '600 12px Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    context.fillStyle = 'rgba(255, 255, 255, 0.95)';
    context.strokeText(label, arrowX, arrowY - size - 12);
    context.fillText(label, arrowX, arrowY - size - 12);
    context.restore();
  }

  function ensurePlayerArrowOverlay(targetCanvas) {
    const doc = win.document;
    if (!state.arrowOverlay?.parentNode) {
      const overlay = doc.createElement('canvas');
      overlay.id = PLAYER_ARROW_CANVAS_ID;
      overlay.setAttribute('aria-hidden', 'true');
      (doc.body || doc.documentElement).appendChild(overlay);
      state.arrowOverlay = overlay;
    }

    if (state.arrowOverlay === targetCanvas) {
      state.arrowOverlay = null;
      return null;
    }

    return state.arrowOverlay;
  }

  function alignPlayerArrowOverlay(overlay, rect) {
    const dpr = getDevicePixelRatio();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (overlay.width !== width || overlay.height !== height) {
      overlay.width = width;
      overlay.height = height;
    }

    const nextLayout = {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const previousLayout = overlay.__blobioArrowLayout || {};
    if (
      previousLayout.left === nextLayout.left
      && previousLayout.top === nextLayout.top
      && previousLayout.width === nextLayout.width
      && previousLayout.height === nextLayout.height
    ) {
      return;
    }

    overlay.__blobioArrowLayout = nextLayout;
    overlay.style.left = `${nextLayout.left}px`;
    overlay.style.top = `${nextLayout.top}px`;
    overlay.style.width = `${nextLayout.width}px`;
    overlay.style.height = `${nextLayout.height}px`;
  }

  function clearPlayerArrowOverlay() {
    const overlay = state.arrowOverlay;
    const context = overlay?.getContext?.('2d');
    if (overlay && context) {
      context.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  function findGameCanvas() {
    const canvases = Array.from(win.document?.querySelectorAll?.('canvas') || []);
    let best = null;
    let bestArea = 0;
    for (const canvas of canvases) {
      if (canvas.id === PLAYER_ARROW_CANVAS_ID) {
        continue;
      }
      const rect = canvas.getBoundingClientRect?.();
      const area = Math.max(0, Number(rect?.width) || 0) * Math.max(0, Number(rect?.height) || 0);
      if (area > bestArea) {
        best = canvas;
        bestArea = area;
      }
    }
    return best;
  }

  function getCellDrawInfo(x, y, radius, cellSize, projectionMatrix) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      return null;
    }

    const projected = projectWorldPoint(Number(x), Number(y), projectionMatrix);
    if (projected) {
      const measureRadius = Math.max(0, Number(radius) || Number(cellSize) / 2 || 0);
      const right = measureRadius > 0 ? projectWorldPoint(Number(x) + measureRadius, Number(y), projectionMatrix) : null;
      const top = measureRadius > 0 ? projectWorldPoint(Number(x), Number(y) + measureRadius, projectionMatrix) : null;
      const projectedRadius = Math.max(
        right ? Math.abs(right.x - projected.x) : 0,
        top ? Math.abs(top.y - projected.y) : 0,
      );
      return {
        x: projected.x,
        y: projected.y,
        size: Math.max(1, projectedRadius * 2 || 42),
        projected: true,
      };
    }

    return {
      x: Number(x),
      y: Number(y),
      size: Math.max(1, Number(radius) * 2 || Number(cellSize) || 42),
      projected: false,
    };
  }

  function projectWorldPoint(x, y, projectionMatrix) {
    const matrix = getMatrixValues(projectionMatrix);
    const viewport = getGameViewport();
    if (!matrix || viewport.width <= 0 || viewport.height <= 0) {
      return null;
    }

    const clipX = matrix[0] * x + matrix[4] * y + matrix[12];
    const clipY = matrix[1] * x + matrix[5] * y + matrix[13];
    const clipW = matrix[3] * x + matrix[7] * y + matrix[15];
    const w = Number.isFinite(clipW) && Math.abs(clipW) > 0.00001 ? clipW : 1;
    const ndcX = clipX / w;
    const ndcY = clipY / w;
    if (!Number.isFinite(ndcX) || !Number.isFinite(ndcY)) {
      return null;
    }

    return {
      x: (ndcX + 1) * 0.5 * viewport.width,
      y: (1 - ndcY) * 0.5 * viewport.height,
    };
  }

  function getMatrixValues(value) {
    const matrix = value?.a || value;
    return matrix && typeof matrix.length === 'number' && matrix.length >= 16 ? matrix : null;
  }

  function getGameViewport() {
    const rect = findGameCanvas()?.getBoundingClientRect?.();
    return {
      width: Number(rect?.width) || Number(win.innerWidth) || 0,
      height: Number(rect?.height) || Number(win.innerHeight) || 0,
    };
  }

  function installPlayerArrowStyle() {
    const doc = win.document;
    if (!doc || doc.getElementById?.('blobio-visible-player-arrow-style')) {
      return;
    }

    const style = doc.createElement('style');
    style.id = 'blobio-visible-player-arrow-style';
    style.textContent = `
#${PLAYER_ARROW_CANVAS_ID} {
  position: fixed;
  z-index: 2147483000;
  pointer-events: none;
  opacity: 0.96;
}

#${PLAYER_ARROW_TOGGLE_ID} {
  position: fixed;
  right: 14px;
  top: 96px;
  z-index: 2147483001;
  min-width: 96px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 7px;
  background: rgba(12, 16, 24, 0.72);
  color: rgba(255, 255, 255, 0.94);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  font: 700 12px Arial, sans-serif;
  pointer-events: auto;
}

#${PLAYER_ARROW_TOGGLE_ID}[data-enabled="true"] {
  border-color: rgba(255, 220, 86, 0.72);
  color: rgba(255, 238, 166, 0.98);
}

#${PLAYER_ANCHOR_TOGGLE_ID} {
  position: fixed;
  right: 14px;
  top: 136px;
  z-index: 2147483001;
  max-width: 190px;
  height: 34px;
  padding: 0 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 7px;
  background: rgba(12, 16, 24, 0.72);
  color: rgba(255, 255, 255, 0.9);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.24);
  cursor: pointer;
  font: 700 12px Arial, sans-serif;
  pointer-events: auto;
}

#${PLAYER_ANCHOR_TOGGLE_ID}[data-locked="true"] {
  border-color: rgba(80, 220, 130, 0.72);
  color: rgba(172, 255, 202, 0.98);
}
`;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function ensurePlayerArrowToggle() {
    const doc = win.document;
    if (!doc?.body) {
      return null;
    }

    let button = doc.getElementById?.(PLAYER_ARROW_TOGGLE_ID);
    if (!button) {
      button = doc.createElement('button');
      button.id = PLAYER_ARROW_TOGGLE_ID;
      button.type = 'button';
      button.addEventListener?.('click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setPlayerArrowsEnabled(!settings.playerArrows);
        button.blur?.();
      });
      doc.body.appendChild(button);
    }

    updatePlayerArrowToggle(button);
    return button;
  }

  function ensurePlayerAnchorToggle() {
    const doc = win.document;
    if (!doc?.body) {
      return null;
    }

    let button = doc.getElementById?.(PLAYER_ANCHOR_TOGGLE_ID);
    if (!button) {
      button = doc.createElement('button');
      button.id = PLAYER_ANCHOR_TOGGLE_ID;
      button.type = 'button';
      button.addEventListener?.('click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        const current = settings.radarAnchorName || '';
        const next = win.prompt?.('Radar anchor name. Leave empty for Auto.', current);
        if (next !== null && next !== undefined) {
          setPlayerRadarAnchorName(next);
        }
        button.blur?.();
      });
      doc.body.appendChild(button);
    }

    updatePlayerAnchorToggle(button);
    return button;
  }

  function updatePlayerArrowToggle(button = win.document?.getElementById?.(PLAYER_ARROW_TOGGLE_ID)) {
    if (!button) {
      return;
    }

    const enabled = Boolean(settings.playerArrows);
    button.dataset.enabled = String(enabled);
    button.textContent = enabled ? 'Arrows: ON' : 'Arrows: OFF';
    button.setAttribute('aria-pressed', String(enabled));
    button.setAttribute('aria-label', enabled ? 'Turn visible player arrows off' : 'Turn visible player arrows on');
  }

  function updatePlayerAnchorToggle(button = win.document?.getElementById?.(PLAYER_ANCHOR_TOGGLE_ID)) {
    if (!button) {
      return;
    }

    const name = normalizeRadarAnchorName(settings.radarAnchorName);
    button.dataset.locked = String(Boolean(name));
    button.textContent = name ? `Anchor: ${name.slice(0, 18)}` : 'Anchor: Auto';
    button.title = name ? `Radar anchor locked to ${name}` : 'Radar anchor follows your player';
    button.setAttribute('aria-label', name ? `Radar anchor locked to ${name}` : 'Radar anchor follows your player');
  }

  function getDevicePixelRatio() {
    return Math.max(1, Math.min(3, Number(win.devicePixelRatio) || 1));
  }

  function sweepLabelCache(now) {
    if (now - lastCacheSweep < 5000 || labelCache.size < 64) {
      return;
    }

    lastCacheSweep = now;
    for (const [cellId, entry] of labelCache) {
      if (now - entry.lastSeen > 30000) {
        labelCache.delete(cellId);
      }
    }
  }

  function installGameScriptPatch() {
    const NodeCtor = win.Node || globalThis.Node;
    if (!NodeCtor?.prototype || NodeCtor.prototype.__blobioCellMassScriptPatchInstalled) {
      return;
    }

    const originalAppendChild = NodeCtor.prototype.appendChild;
    const originalInsertBefore = NodeCtor.prototype.insertBefore;

    NodeCtor.prototype.appendChild = function blobioCellMassAppendChild(node) {
      if (shouldWatchScript(node)) {
        node.dataset.blobioCellMassScriptPatch = 'seen';
        state.seenCacheScripts += 1;
        installGwtCallbackPatch();
      }
      return originalAppendChild.call(this, node);
    };

    NodeCtor.prototype.insertBefore = function blobioCellMassInsertBefore(node, child) {
      if (shouldWatchScript(node)) {
        node.dataset.blobioCellMassScriptPatch = 'seen';
        state.seenCacheScripts += 1;
        installGwtCallbackPatch();
      }
      return originalInsertBefore.call(this, node, child);
    };

    NodeCtor.prototype.__blobioCellMassScriptPatchInstalled = true;
    installGwtCallbackPatch();

    const timer = win.setInterval?.(() => {
      if (installGwtCallbackPatch()) {
        win.clearInterval?.(timer);
      }
    }, 10);
    win.setTimeout?.(() => win.clearInterval?.(timer), 30000);
  }

  function shouldWatchScript(node) {
    return node
      && node.tagName === 'SCRIPT'
      && node.src
      && node.dataset
      && !node.dataset.blobioCellMassScriptPatch
      && CACHE_SCRIPT_RE.test(node.src);
  }

  function installGwtCallbackPatch() {
    const html = win.html;
    if (!html || html.__blobioCellMassCallbackWrapped || typeof html.onScriptDownloaded !== 'function') {
      return false;
    }

    const original = html.onScriptDownloaded;
    html.onScriptDownloaded = function blobioCellMassOnScriptDownloaded(chunks) {
      let patchedChunks = chunks;
      try {
        patchedChunks = Array.isArray(chunks)
          ? chunks.map((chunk) => patchDownloadedChunk(chunk))
          : patchDownloadedChunk(chunks);
      } catch (error) {
        rememberError(`GWT patch failed: ${getErrorMessage(error)}`);
      }

      return original.call(this, patchedChunks);
    };

    html.__blobioCellMassCallbackWrapped = true;
    state.wrappedCallback = true;
    return true;
  }

  function patchDownloadedChunk(chunk) {
    if (typeof chunk !== 'string') {
      return chunk;
    }

    const result = patchGameBundle(chunk);
    if (result.changed || !state.lastPatchResult) {
      state.lastPatchResult = compactPatchResult(result);
    }

    if (!result.changed) {
      return chunk;
    }

    state.patchedChunks += 1;
    return result.source;
  }

  function patchGameBundle(source) {
    if (typeof source !== 'string') {
      return { source, changed: false, reason: 'not-a-string' };
    }

    if (source.includes(`${PATCH_MARKER}(g.n,g.w*g.w/100`)) {
      return { source, changed: false, reason: 'already-patched' };
    }

    const nameBlockStart = 'Mm(a.i,g.u?a.b:g.r?a.a:a.B);if(Nye(qxe.f,(Ize(),Gze))&&g.B!=null){';
    const nameDrawEnd = 'Gm(a.i,a.c,g.B,b,c)}}}}';

    if (!source.includes(nameBlockStart) || !source.includes(nameDrawEnd)) {
      return { source, changed: false, reason: 'renderer-block-not-found' };
    }

    let patched = source.replace(
      nameBlockStart,
      'Mm(a.i,g.u?a.b:g.r?a.a:a.B);d=false;if(Nye(qxe.f,(Ize(),Gze))&&g.B!=null){',
    );

    const drawPatch = [
      'Gm(a.i,a.c,g.B,b,c);d=true}}',
      'if($wnd.BlobioCellMassDraw&&(!g.c||(g.c.M!=2&&g.c.M!=3&&g.c.M!=4&&g.c.M!=10))){',
      'h=$wnd.BlobioCellMassDraw(g.n,g.w*g.w/100,g.w,g.M,g.N,g.B,d,d?f:0,0,qxe.g/100,g.R,g.S,g.c?g.c.M:-1,g.u,g.r,a.c&&a.c.g&&a.c.g.a);',
      'if(h&&h.text){',
      'f=d?a.o.b:0;',
      'Mm(a.i,a.B);',
      'Nn(a.i.b,h.scale);',
      'xp(a.o,a.i,h.text);',
      'if(a.o.d>g.N*h.maxWidth){h.scale*=g.N*h.maxWidth/a.o.d;Nn(a.i.b,h.scale);xp(a.o,a.i,h.text)}',
      'if(a.o.b>g.N*h.maxHeight){h.scale*=g.N*h.maxHeight/a.o.b;Nn(a.i.b,h.scale);xp(a.o,a.i,h.text)}',
      'b=g.R-a.o.d/2;',
      'c=g.S-a.o.b/2;',
      'd&&(c+=f*h.lineGap+a.o.b*0.55);',
      'c+=h.offset;',
      'c=$wnd.Math.max(g.S-g.M,c);',
      'c=$wnd.Math.min(g.S+g.M-a.o.b,c);',
      '$wnd.__blobioCellMassCaptureDraw&&$wnd.__blobioCellMassCaptureDraw(g.n,h,a.B,b,c);',
      'Gm(a.i,a.c,h.text,b,c);',
      'Nn(a.i.b,1)',
      '}}}}',
    ].join('');

    patched = patched.replace(nameDrawEnd, drawPatch);
    if (patched === source) {
      return { source, changed: false, reason: 'replace-failed' };
    }

    return { source: patched, changed: true, reason: 'patched' };
  }

  function compactPatchResult(result) {
    return {
      changed: Boolean(result.changed),
      reason: result.reason || '',
      sourceLength: typeof result.source === 'string' ? result.source.length : 0,
    };
  }

  function rememberSample(cellId, mass, rawSize, renderSize, cellSize, name, nameDrawn, result) {
    if (state.counters.labelsDrawn % 30 !== 1) {
      return;
    }

    state.samples.push({
      cellId,
      mass: Math.round(mass * 10) / 10,
      rawSize,
      renderSize,
      cellSize,
      name: typeof name === 'string' ? name.slice(0, 32) : '',
      nameDrawn,
      text: result.text,
      scale: Math.round(result.scale * 1000) / 1000,
      primary: result.primary,
      cached: result.cached,
    });

    if (state.samples.length > 12) {
      state.samples.shift();
    }
  }

  function debugReport() {
    const report = {
      installed: true,
      version: SCRIPT_VERSION,
      url: win.location?.href || '',
      uptimeMs: Date.now() - state.startedAt,
      settings: { ...settings },
      counters: { ...state.counters, cachedCells: labelCache.size },
      patch: {
        seenCacheScripts: state.seenCacheScripts,
        wrappedCallback: state.wrappedCallback,
        patchedChunks: state.patchedChunks,
        lastPatchResult: state.lastPatchResult,
      },
      samples: state.samples.slice(),
      performance: {
        visiblePlayerCells: visiblePlayers.size,
        labelBudget: {
          calls: labelBudget.calls,
          smallLabels: labelBudget.smallLabels,
          protectedLabels: labelBudget.protectedLabels,
          windowAgeMs: roundNumber(getPerfNow() - labelBudget.windowStart),
        },
        visiblePlayerCacheAgeMs: visiblePlayersSnapshotAt ? Date.now() - visiblePlayersSnapshotAt : null,
        radarCacheAgeMs: radarGroupSnapshotAt ? Date.now() - radarGroupSnapshotAt : null,
      },
      visiblePlayers: getVisiblePlayers(),
      lastLabel: state.lastLabel,
      lastDrawCapture: state.lastDrawCapture,
      lastRadar: state.lastRadar,
      commands: [
        'BlobioCellMassDebug()',
        'BlobioShowMassDebug()',
        'blobioCellMassDebug()',
        'BlobioVisiblePlayers()',
        'BlobioRadarAnchorName("player name")',
      ],
      errors: state.errors.slice(-8),
    };

    try {
      win.console?.log?.('[Blobio Cell Mass] debug', report);
      win.console?.log?.('[Blobio Cell Mass] JSON:', JSON.stringify(report));
    } catch {}
    return report;
  }

  function normalizeSettings(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const defaults = {
      enabled: true,
      compact: true,
      smartRendering: true,
      emphasizeBiggest: true,
      mode: 'normal',
      textScale: 0.65,
      yOffset: 10,
      nameGap: 1.2,
      updateDelayMs: 3000,
      playerArrows: false,
      radarAnchorName: 'topg',
    };

    return {
      enabled: source.enabled === undefined ? defaults.enabled : Boolean(source.enabled),
      compact: source.compact === undefined ? defaults.compact : Boolean(source.compact),
      smartRendering: source.smartRendering === undefined ? defaults.smartRendering : Boolean(source.smartRendering),
      emphasizeBiggest: source.emphasizeBiggest === undefined ? defaults.emphasizeBiggest : Boolean(source.emphasizeBiggest),
      mode: ['normal', 'vip', 'custom'].includes(source.mode) ? source.mode : defaults.mode,
      textScale: clampNumber(source.textScale, 0.35, 1.4, defaults.textScale),
      yOffset: clampNumber(source.yOffset, -120, 120, defaults.yOffset),
      nameGap: clampNumber(source.nameGap, 0.1, 3, defaults.nameGap),
      updateDelayMs: Math.round(clampNumber(source.updateDelayMs, 0, 10000, defaults.updateDelayMs)),
      playerArrows: source.playerArrows === undefined ? defaults.playerArrows : Boolean(source.playerArrows),
      radarAnchorName: source.radarAnchorName === undefined ? defaults.radarAnchorName : normalizeRadarAnchorName(source.radarAnchorName),
    };
  }

  function normalizeRadarAnchorName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function persistSettings() {
    const snapshot = {
      ...settings,
      updatedAt: Date.now(),
    };

    try {
      win.localStorage?.setItem?.(CELL_MASS_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {}

    try {
      win.postMessage?.({
        source: STORAGE_BRIDGE_SOURCE,
        type: 'set',
        key: CELL_MASS_SNAPSHOT_KEY,
        value: JSON.stringify(snapshot),
      }, '*');
    } catch {}

    try {
      const value = encodeURIComponent(JSON.stringify(snapshot));
      const hostname = String(win.location?.hostname || '');
      const domain = hostname === 'blobgame.io' || hostname.endsWith('.blobgame.io')
        ? '; Domain=.blobgame.io'
        : '';
      win.document.cookie = `${CELL_MASS_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; SameSite=Lax${domain}`;
    } catch {}
  }

  function clampNumber(value, min, max, fallback) {
    if (value === null || value === undefined || value === '') {
      return fallback;
    }
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function lerpNumber(from, to, amount) {
    const start = Number(from);
    const end = Number(to);
    if (!Number.isFinite(end)) {
      return to;
    }
    if (!Number.isFinite(start)) {
      return end;
    }
    return start + (end - start) * amount;
  }

  function getPerfNow() {
    const now = win.performance?.now?.();
    return Number.isFinite(Number(now)) ? Number(now) : Date.now();
  }

  function rememberError(message) {
    state.errors.push({
      at: Date.now(),
      message,
    });
    if (state.errors.length > 20) {
      state.errors.shift();
    }
  }

  function cloneRendererColor(color) {
    if (!color || typeof color !== 'object') {
      return null;
    }
    return {
      d: roundNumber(color.d),
      c: roundNumber(color.c),
      b: roundNumber(color.b),
      a: roundNumber(color.a),
    };
  }

  function roundNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number * 10000) / 10000 : 0;
  }

  function getErrorMessage(error) {
    return error?.message || String(error);
  }
}
