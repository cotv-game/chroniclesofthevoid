// engine/rulesEngine.js
/**
 * Kroniky Prázdnoty — Rules Engine v0.5.3
 *
 * Novinky v této verzi:
 * ✅ Události (globální) — implementace karty "Mlha nenadání":
 *    - Po vyložení platí až do začátku příštího kola (interpretace: do začátku příštího tahu hráče, který Událost zahrál).
 *    - Během trvání: žádný hráč NESMÍ útočit ani vcházet/vycházet z Prázdnoty.
 *    - Poté se Událost vyřadí na hřbitov.
 * ✅ Přidána akce END_TURN (kvůli situacím, kdy útok není možný / nebo hráč nechce útočit).
 */

export const Duration = Object.freeze({
  INSTANT: 'INSTANT',
  UNTIL_END_OF_TURN: 'UNTIL_END_OF_TURN',
  UNTIL_END_OF_ROUND: 'UNTIL_END_OF_ROUND',
  PERMANENT: 'PERMANENT',
});

// ------------------------------------------------------------
// STATE INIT
// ------------------------------------------------------------

export function createInitialState({
  deckA = [],
  deckB = [],
  startingBO = 5,
  targetBV = 20,
  cardDB = {},
} = {}) {
  const state = {
    config: { targetBV },

    turn: {
      number: 1,
      activePlayer: 'A',
      actionsLeft: 3,
      canAttack: false, // 1. kolo: útok zakázán
    },

    players: {
      A: { BO: startingBO, BV: 0, deck: [...deckA], hand: [], grave: [], board: [], void: [], location: null },
      B: { BO: startingBO, BV: 0, deck: [...deckB], hand: [], grave: [], board: [], void: [], location: null },
    },

    entities: {
      warriors: {},
    },

    // dočasné bojové flagy
    combat: {
      forcedMeleeOnly: new Set(),
    },

    // modifikátory
    effects: {
      modifiers: [],
    },

    // globální Událost (jen jedna aktivní)
    globalEvent: null, // { cardInstanceId, cardId, ownerPlayerId, expiresAtTurnNumber, effects:{ noAttack, noVoidMove } }

    // stack a reakce
    stack: [],
    reaction: {
      open: false,
      priority: null,
      lastPassBy: null,
      context: null, // { reason, pendingAction }
    },

    log: [],
  };

  // setup: oba líznou 7
  drawUpTo(state, 'A', 7);
  drawUpTo(state, 'B', 7);

  // určení startéra
  state.turn.activePlayer = determineStartingPlayer(state, cardDB);
  state.turn.actionsLeft = 3;
  state.turn.canAttack = false;

  return state;
}

// ------------------------------------------------------------
// LEGAL ACTIONS
// ------------------------------------------------------------

export function getLegalActions(state, playerId, cardDB) {
  const actions = [];
  const isActive = state.turn.activePlayer === playerId;
  const opp = other(playerId);

  // Reaction window: jen hráč s prioritou
  if (state.reaction.open) {
    if (state.reaction.priority !== playerId) return actions;

    actions.push({ type: 'PASS', playerId });

    // v reakci lze hrát taktiky
    for (const cardInstanceId of state.players[playerId].hand) {
      const def = cardDB[getCardIdFromInstance(cardInstanceId)];
      if (!def) continue;
      if (normType(def.type) !== 'TAKTIKA') continue;

      const boCost = def.playBoCost ?? 0;
      if (state.players[playerId].BO >= boCost) {
        actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId });
      }
    }

    return actions;
  }

  // mimo svůj tah: pouze taktiky
  if (!isActive) {
    for (const cardInstanceId of state.players[playerId].hand) {
      const def = cardDB[getCardIdFromInstance(cardInstanceId)];
      if (!def) continue;
      if (normType(def.type) !== 'TAKTIKA') continue;

      const boCost = def.playBoCost ?? 0;
      if (state.players[playerId].BO >= boCost) {
        actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId });
      }
    }
    return actions;
  }

  // vlastní tah
  if (state.turn.actionsLeft > 0) {
    // END_TURN je vždy dostupný ve vlastním tahu (pravidlo odhození na konci tahu řeší UI)
    actions.push({ type: 'END_TURN', playerId });

    actions.push({ type: 'MEDITATE', playerId });

    // vyložení karet
    for (const cardInstanceId of state.players[playerId].hand) {
      const def = cardDB[getCardIdFromInstance(cardInstanceId)];
      if (!def) continue;

      const t = normType(def.type);

      if (t === 'TAKTIKA') {
        const boCost = def.playBoCost ?? 0;
        if (state.players[playerId].BO >= boCost) {
          actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId });
        }
      } else if (t === 'BOJOVNIK') {
        const cost = getBaseStats(def).H;
        if (state.players[playerId].BO >= cost) {
          actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId });
        }
      } else if (isAttachType(t)) {
        actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId, requiresTarget: true, targetKind: 'OWN_WARRIOR' });
      } else {
        actions.push({ type: 'PLAY_CARD', playerId, cardInstanceId });
      }
    }

    // pohyb do/ven z Prázdnoty (pokud není blokován globální Událostí)
    if (!isNoVoidMoveActive(state)) {
      for (const wid of state.players[playerId].board) {
        const w = state.entities.warriors[wid];
        if (w && w.zone === 'DRUZSTVO') actions.push({ type: 'MOVE_TO_VOID', playerId, warriorId: wid });
      }
      for (const wid of state.players[playerId].void) {
        const w = state.entities.warriors[wid];
        if (w && w.zone === 'PRAZDNOTA') actions.push({ type: 'RETURN_FROM_VOID', playerId, warriorId: wid });
      }
    }

    // ENGINEER_REPAIR – 2 akce
    if (state.turn.actionsLeft >= 2) {
      const engineers = state.players[playerId].board
        .map(wid => state.entities.warriors[wid])
        .filter(w => w && w.zone === 'DRUZSTVO' && w.flags?.ENGINEER_REPAIR === true);

      if (engineers.length > 0) {
        const candidates = state.players[playerId].board
          .map(wid => state.entities.warriors[wid])
          .filter(w => w && w.zone === 'DRUZSTVO' && w.damaged === true)
          .filter(w => normFaction(w.faction) === 'eurasia')
          .filter(w => (w.flags?.DRONE === true) || (w.flags?.MECH === true));

        for (const eng of engineers) {
          for (const target of candidates) {
            actions.push({
              type: 'ACTIVATE_ABILITY',
              playerId,
              sourceWarriorId: eng.id,
              abilityKey: 'ENGINEER_REPAIR',
              targetWarriorId: target.id,
              actionCost: 2,
            });
          }
        }
      }
    }

    // VOID_ATTACK – 1 akce, ale obsahuje útok => po vyhodnocení útoku tah končí
    // Platí zákaz útoku v 1. kole a může být blokován globální Událostí.
    if (state.turn.canAttack && state.turn.actionsLeft >= 1 && !isNoAttackActive(state) && !isNoVoidMoveActive(state)) {
      const voidAttackers = state.players[playerId].void
        .map(wid => state.entities.warriors[wid])
        .filter(w => w && w.zone === 'PRAZDNOTA' && w.flags?.VOID_PHANTOM === true);

      if (voidAttackers.length > 0) {
        const defenders = state.players[opp].board
          .map(wid => state.entities.warriors[wid])
          .filter(w => w && w.zone === 'DRUZSTVO');

        for (const a of voidAttackers) {
          if (defenders.length > 0) {
            for (const d of defenders) {
              actions.push({ type: 'ACTIVATE_ABILITY', playerId, sourceWarriorId: a.id, abilityKey: 'VOID_ATTACK', actionCost: 1, targetType: 'WARRIOR', targetId: d.id, mode: 'S' });
              actions.push({ type: 'ACTIVATE_ABILITY', playerId, sourceWarriorId: a.id, abilityKey: 'VOID_ATTACK', actionCost: 1, targetType: 'WARRIOR', targetId: d.id, mode: 'Z' });
            }
          } else {
            actions.push({ type: 'ACTIVATE_ABILITY', playerId, sourceWarriorId: a.id, abilityKey: 'VOID_ATTACK', actionCost: 1, targetType: 'PLAYER', targetId: opp, mode: 'S' });
            actions.push({ type: 'ACTIVATE_ABILITY', playerId, sourceWarriorId: a.id, abilityKey: 'VOID_ATTACK', actionCost: 1, targetType: 'PLAYER', targetId: opp, mode: 'Z' });
          }
        }
      }
    }
  }

  // běžný útok jen jako poslední akce (a nesmí být blokován Událostí)
  if (state.turn.actionsLeft === 1 && state.turn.canAttack && !isNoAttackActive(state)) {
    const attackers = state.players[playerId].board.map(id => state.entities.warriors[id]).filter(w => w && w.zone === 'DRUZSTVO');
    const defenders = state.players[opp].board.map(id => state.entities.warriors[id]).filter(w => w && w.zone === 'DRUZSTVO');

    for (const a of attackers) {
      if (defenders.length > 0) {
        for (const d of defenders) {
          actions.push({ type: 'ATTACK', playerId, attackerId: a.id, targetType: 'WARRIOR', targetId: d.id, mode: 'S' });
          actions.push({ type: 'ATTACK', playerId, attackerId: a.id, targetType: 'WARRIOR', targetId: d.id, mode: 'Z' });
        }
      } else {
        actions.push({ type: 'ATTACK', playerId, attackerId: a.id, targetType: 'PLAYER', targetId: opp, mode: 'S' });
        actions.push({ type: 'ATTACK', playerId, attackerId: a.id, targetType: 'PLAYER', targetId: opp, mode: 'Z' });
      }
    }
  }

  return actions;
}

export function getLegalTargetsForAction(state, action, cardDB) {
  if (!action || action.type !== 'PLAY_CARD' || !action.cardInstanceId) return [];
  const def = cardDB[getCardIdFromInstance(action.cardInstanceId)];
  if (!def) return [];

  const t = normType(def.type);
  if (isAttachType(t)) {
    const pid = action.playerId;
    return state.players[pid].board
      .map(wid => state.entities.warriors[wid])
      .filter(w => w && w.zone === 'DRUZSTVO')
      .map(w => w.id);
  }

  return [];
}

export function getEquipmentInstancesInPlay(state) {
  const out = [];
  for (const w of Object.values(state.entities.warriors)) {
    for (const eq of (w?.attachments?.equipment ?? [])) out.push(eq);
  }
  return out;
}

// ------------------------------------------------------------
// APPLY ACTION
// ------------------------------------------------------------

export function applyAction(state, action, cardDB) {
  const events = [];

  if (!action || !action.type || !action.playerId) {
    return { state, events: [{ type: 'ERROR', message: 'Invalid action payload' }] };
  }

  // --- reaction window ---
  if (state.reaction.open) {
    if (state.reaction.priority !== action.playerId) {
      return { state, events: [{ type: 'ERROR', message: 'Not your priority' }] };
    }

    if (action.type === 'PASS') {
      events.push({ type: 'PASS', playerId: action.playerId });

      if (state.reaction.lastPassBy && state.reaction.lastPassBy !== action.playerId) {
        // oba po sobě PASS
        if (state.stack.length > 0) {
          state.reaction.lastPassBy = null;
          resolveTopOfStack(state, events, cardDB);
          openReactionWindow(state, events, { reason: 'AFTER_STACK_RESOLVE', pendingAction: state.reaction.context?.pendingAction ?? null });
          return { state, events };
        }

        // stack prázdný => zavři okno a resolve pending
        const pending = state.reaction.context?.pendingAction ?? null;
        closeReactionWindow(state, events);
        if (pending) resolvePendingAction(state, pending, events, cardDB);
        return { state, events };
      }

      // první PASS
      state.reaction.lastPassBy = action.playerId;
      state.reaction.priority = other(action.playerId);
      events.push({ type: 'PRIORITY_CHANGED', priority: state.reaction.priority });
      return { state, events };
    }

    if (action.type === 'PLAY_CARD') {
      const ok = playTacticToStack(state, action, events, cardDB);
      if (ok) {
        state.reaction.lastPassBy = null;
        state.reaction.priority = other(action.playerId);
        events.push({ type: 'PRIORITY_CHANGED', priority: state.reaction.priority });
      }
      return { state, events };
    }

    return { state, events: [{ type: 'ERROR', message: 'Only PASS or PLAY_CARD allowed in reaction window' }] };
  }

  // --- normal flow ---
  const isActive = state.turn.activePlayer === action.playerId;

  // mimo tah: dovol jen taktiku
  if (!isActive) {
    if (action.type !== 'PLAY_CARD') {
      return { state, events: [{ type: 'ERROR', message: 'Not your turn' }] };
    }

    const def = cardDB[getCardIdFromInstance(action.cardInstanceId)];
    if (!def || normType(def.type) !== 'TAKTIKA') {
      return { state, events: [{ type: 'ERROR', message: 'Out-of-turn only tactics are allowed' }] };
    }

    openReactionWindow(state, events, { reason: 'OUT_OF_TURN_TACTIC', pendingAction: action });
    events.push({ type: 'ACTION_DECLARED', action });
    events.push({ type: 'INFO', message: 'Tactic declared out of turn. Opponent reacts first.' });
    return { state, events };
  }

  events.push({ type: 'ACTION_DECLARED', action });

  switch (action.type) {
    case 'END_TURN': {
      // ukončení tahu bez útoku
      endTurnCommon(state, events);
      return { state, events };
    }

    case 'MEDITATE': {
      ensureActions(state, 1);
      state.turn.actionsLeft -= 1;
      state.players[action.playerId].BO += 1;
      events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });
      events.push({ type: 'BO_CHANGED', playerId: action.playerId, delta: +1 });
      openReactionWindow(state, events, { reason: 'AFTER_MEDITATE' });
      return { state, events };
    }

    case 'MOVE_TO_VOID': {
      if (isNoVoidMoveActive(state)) {
        return { state, events: [...events, { type: 'ERROR', message: 'Void movement is blocked by a global event' }] };
      }
      ensureActions(state, 1);
      state.turn.actionsLeft -= 1;
      const w = state.entities.warriors[action.warriorId];
      if (!w || w.owner !== action.playerId || w.zone !== 'DRUZSTVO') {
        return { state, events: [...events, { type: 'ERROR', message: 'Invalid warrior for MOVE_TO_VOID' }] };
      }
      moveWarriorZone(state, w.id, 'PRAZDNOTA', events);
      events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });
      openReactionWindow(state, events, { reason: 'AFTER_MOVE_TO_VOID' });
      return { state, events };
    }

    case 'RETURN_FROM_VOID': {
      if (isNoVoidMoveActive(state)) {
        return { state, events: [...events, { type: 'ERROR', message: 'Void movement is blocked by a global event' }] };
      }
      ensureActions(state, 1);
      state.turn.actionsLeft -= 1;
      const w = state.entities.warriors[action.warriorId];
      if (!w || w.owner !== action.playerId || w.zone !== 'PRAZDNOTA') {
        return { state, events: [...events, { type: 'ERROR', message: 'Invalid warrior for RETURN_FROM_VOID' }] };
      }
      moveWarriorZone(state, w.id, 'DRUZSTVO', events);
      events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });
      openReactionWindow(state, events, { reason: 'AFTER_RETURN_FROM_VOID' });
      return { state, events };
    }

    case 'PLAY_CARD': {
      const def = cardDB[getCardIdFromInstance(action.cardInstanceId)];
      if (!def) return { state, events: [...events, { type: 'ERROR', message: 'Unknown cardId' }] };
      const t = normType(def.type);

      if (t === 'TAKTIKA') {
        openReactionWindow(state, events, { reason: 'TACTIC_DECLARED', pendingAction: action });
        events.push({ type: 'INFO', message: 'Tactic declared. Opponent reacts first.' });
        return { state, events };
      }

      ensureActions(state, 1);
      state.turn.actionsLeft -= 1;
      events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });

      if (t === 'BOJOVNIK') {
        const cost = getBaseStats(def).H;
        ensureBO(state, action.playerId, cost);
        state.players[action.playerId].BO -= cost;
        events.push({ type: 'BO_CHANGED', playerId: action.playerId, delta: -cost });
        spawnWarrior(state, action.playerId, action.cardInstanceId, def, events);
      } else if (isAttachType(t)) {
        const targetId = action.targetWarriorId;
        if (!targetId) return { state, events: [...events, { type: 'ERROR', message: 'Attach card requires targetWarriorId' }] };
        const target = state.entities.warriors[targetId];
        if (!target || target.owner !== action.playerId || target.zone !== 'DRUZSTVO') {
          return { state, events: [...events, { type: 'ERROR', message: 'Invalid attach target' }] };
        }
        attachCardToWarrior(state, action.playerId, action.cardInstanceId, def, targetId, events);
      } else if (t === 'LOKACE') {
        playLocation(state, action.playerId, action.cardInstanceId, events);
      } else if (t === 'UDALOST') {
        // událost: globální slot
        playGlobalEvent(state, action.playerId, action.cardInstanceId, def, events);
      } else {
        moveCardInstance(state, action.playerId, action.cardInstanceId, 'HAND', 'GRAVE', events, t);
        events.push({ type: 'INFO', message: `${t} je zatím placeholder (přesun do GRAVE).` });
      }

      openReactionWindow(state, events, { reason: 'AFTER_PLAY_CARD' });
      return { state, events };
    }

    case 'ATTACK': {
      if (isNoAttackActive(state)) {
        return { state, events: [...events, { type: 'ERROR', message: 'Attacks are blocked by a global event' }] };
      }
      if (!state.turn.canAttack) return { state, events: [...events, { type: 'ERROR', message: 'Attack not allowed in turn 1' }] };
      if (state.turn.actionsLeft !== 1) return { state, events: [...events, { type: 'ERROR', message: 'Attack must be last action (actionsLeft===1)' }] };

      openReactionWindow(state, events, { reason: 'ATTACK_DECLARED', pendingAction: action });
      events.push({ type: 'INFO', message: 'Attack declared. Opponent reacts first.' });
      return { state, events };
    }

    case 'ACTIVATE_ABILITY': {
      // ENGINEER_REPAIR
      if (action.abilityKey === 'ENGINEER_REPAIR') {
        ensureActions(state, 2);

        const source = state.entities.warriors[action.sourceWarriorId];
        const target = state.entities.warriors[action.targetWarriorId];

        if (!source || source.owner !== action.playerId || source.zone !== 'DRUZSTVO' || source.flags?.ENGINEER_REPAIR !== true) {
          return { state, events: [...events, { type: 'ERROR', message: 'Invalid source for ENGINEER_REPAIR' }] };
        }
        if (!target || target.owner !== action.playerId || target.zone !== 'DRUZSTVO') {
          return { state, events: [...events, { type: 'ERROR', message: 'Invalid target for ENGINEER_REPAIR' }] };
        }

        if (normFaction(target.faction) !== 'eurasia') {
          return { state, events: [...events, { type: 'ERROR', message: 'ENGINEER_REPAIR: target must be Eurasia' }] };
        }
        if (!(target.flags?.DRONE === true || target.flags?.MECH === true)) {
          return { state, events: [...events, { type: 'ERROR', message: 'ENGINEER_REPAIR: target must be DRONE or MECH' }] };
        }
        if (target.damaged !== true) {
          return { state, events: [...events, { type: 'ERROR', message: 'ENGINEER_REPAIR: target is not damaged' }] };
        }

        state.turn.actionsLeft -= 2;
        events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });
        events.push({ type: 'ABILITY_ACTIVATED', abilityKey: 'ENGINEER_REPAIR', sourceWarriorId: source.id, targetWarriorId: target.id });

        target.damaged = false;
        events.push({ type: 'WARRIOR_HEALED', targetWarriorId: target.id });

        openReactionWindow(state, events, { reason: 'AFTER_ABILITY' });
        return { state, events };
      }

      // VOID_ATTACK (blokuje ho i Událost, protože jde o útok i pohyb z Prázdnoty)
      if (action.abilityKey === 'VOID_ATTACK') {
        if (isNoAttackActive(state) || isNoVoidMoveActive(state)) {
          return { state, events: [...events, { type: 'ERROR', message: 'VOID_ATTACK is blocked by a global event' }] };
        }
        if (!state.turn.canAttack) {
          return { state, events: [...events, { type: 'ERROR', message: 'VOID_ATTACK not allowed in turn 1' }] };
        }

        ensureActions(state, 1);

        const source = state.entities.warriors[action.sourceWarriorId];
        if (!source || source.owner !== action.playerId || source.zone !== 'PRAZDNOTA' || source.flags?.VOID_PHANTOM !== true) {
          return { state, events: [...events, { type: 'ERROR', message: 'Invalid source for VOID_ATTACK' }] };
        }

        const oppId = other(action.playerId);
        const oppHasDefenders = state.players[oppId].board.some(wid => state.entities.warriors[wid]?.zone === 'DRUZSTVO');

        if (action.targetType === 'PLAYER') {
          if (oppHasDefenders) {
            return { state, events: [...events, { type: 'ERROR', message: 'Direct attack not allowed while opponent has warriors' }] };
          }
        } else if (action.targetType === 'WARRIOR') {
          const d = state.entities.warriors[action.targetId];
          if (!d || d.owner === action.playerId || d.zone !== 'DRUZSTVO') {
            return { state, events: [...events, { type: 'ERROR', message: 'Invalid defender for VOID_ATTACK' }] };
          }
        } else {
          return { state, events: [...events, { type: 'ERROR', message: 'VOID_ATTACK: invalid targetType' }] };
        }

        if (action.mode !== 'S' && action.mode !== 'Z') {
          return { state, events: [...events, { type: 'ERROR', message: 'VOID_ATTACK: invalid mode' }] };
        }

        state.turn.actionsLeft -= 1;
        events.push({ type: 'ACTIONS_CHANGED', actionsLeft: state.turn.actionsLeft });
        events.push({ type: 'ABILITY_ACTIVATED', abilityKey: 'VOID_ATTACK', sourceWarriorId: source.id, targetType: action.targetType, targetId: action.targetId, mode: action.mode });

        openReactionWindow(state, events, { reason: 'VOID_ATTACK_DECLARED', pendingAction: action });
        events.push({ type: 'INFO', message: 'VOID_ATTACK declared. Opponent can react with tactics.' });
        return { state, events };
      }

      return { state, events: [...events, { type: 'ERROR', message: 'Unknown abilityKey' }] };
    }

    default:
      return { state, events: [...events, { type: 'ERROR', message: `Unsupported action type: ${action.type}` }] };
  }
}

// ------------------------------------------------------------
// RESOLVE pending action
// ------------------------------------------------------------

function resolvePendingAction(state, action, events, cardDB) {
  if (!action) return;

  if (action.type === 'PLAY_CARD') {
    const def = cardDB[getCardIdFromInstance(action.cardInstanceId)];
    if (!def || normType(def.type) !== 'TAKTIKA') {
      events.push({ type: 'ERROR', message: 'Pending PLAY_CARD expected to be TACTIC' });
      return;
    }

    const ok = playTacticToStack(state, action, events, cardDB);
    if (!ok) return;

    resolveTopOfStack(state, events, cardDB);
    return;
  }

  if (action.type === 'ACTIVATE_ABILITY' && action.abilityKey === 'VOID_ATTACK') {
    // Resolve: opustí Prázdnotu -> útok -> konec tahu
    const source = state.entities.warriors[action.sourceWarriorId];
    if (!source || source.owner !== action.playerId || source.zone !== 'PRAZDNOTA') {
      events.push({ type: 'ERROR', message: 'VOID_ATTACK resolve failed: source not in void' });
      return;
    }

    moveWarriorZone(state, source.id, 'DRUZSTVO', events);

    resolveAttack(state, {
      playerId: action.playerId,
      attackerId: source.id,
      targetType: action.targetType,
      targetId: action.targetId,
      mode: action.mode,
    }, events);

    endTurnAfterAttack(state, events);
    return;
  }

  if (action.type === 'ATTACK') {
    resolveAttack(state, action, events);
    endTurnAfterAttack(state, events);
    return;
  }
}

// ------------------------------------------------------------
// REACTION WINDOW + STACK
// ------------------------------------------------------------

function openReactionWindow(state, events, context = {}) {
  state.reaction.open = true;
  state.reaction.lastPassBy = null;
  state.reaction.context = context;
  state.reaction.priority = other(state.turn.activePlayer);
  events.push({ type: 'REACTION_WINDOW_OPENED', priority: state.reaction.priority, context });
}

function closeReactionWindow(state, events) {
  state.reaction.open = false;
  state.reaction.priority = null;
  state.reaction.lastPassBy = null;
  state.reaction.context = null;
  events.push({ type: 'REACTION_WINDOW_CLOSED' });
}

function playTacticToStack(state, action, events, cardDB) {
  const playerId = action.playerId;
  const hand = state.players[playerId].hand;
  const idx = hand.indexOf(action.cardInstanceId);
  if (idx < 0) {
    events.push({ type: 'ERROR', message: 'Card not in hand' });
    return false;
  }

  const def = cardDB[getCardIdFromInstance(action.cardInstanceId)];
  if (!def || normType(def.type) !== 'TAKTIKA') {
    events.push({ type: 'ERROR', message: 'Only tactics can be played to stack' });
    return false;
  }

  const boCost = def.playBoCost ?? 0;
  if (state.players[playerId].BO < boCost) {
    events.push({ type: 'ERROR', message: 'Not enough BO' });
    return false;
  }

  state.players[playerId].BO -= boCost;
  events.push({ type: 'BO_CHANGED', playerId, delta: -boCost });

  hand.splice(idx, 1);

  const stackItem = {
    id: genId('stk'),
    kind: 'TACTIC',
    owner: playerId,
    sourceCardInstanceId: action.cardInstanceId,
    payload: {
      cardId: getCardIdFromInstance(action.cardInstanceId),
      targets: action.targets ?? null,
    },
  };

  state.stack.push(stackItem);
  events.push({ type: 'CARD_MOVED', cardInstanceId: action.cardInstanceId, from: 'HAND', to: 'STACK' });
  events.push({ type: 'STACK_PUSH', itemId: stackItem.id, cardId: stackItem.payload.cardId });

  return true;
}

function resolveTopOfStack(state, events, cardDB) {
  const item = state.stack.pop();
  if (!item) return;

  events.push({ type: 'STACK_POP', itemId: item.id });

  if (item.kind === 'TACTIC') {
    const def = cardDB[item.payload.cardId];
    const ability = def?.abilities?.[0] ?? null;

    if (ability) {
      resolveAbilityEffect(state, item.owner, ability, item.payload.targets, events);
    } else {
      events.push({ type: 'TACTIC_NO_EFFECT', cardId: item.payload.cardId });
    }

    state.players[item.owner].grave.push(item.sourceCardInstanceId);
    events.push({ type: 'CARD_MOVED', cardInstanceId: item.sourceCardInstanceId, from: 'STACK', to: 'GRAVE' });
    events.push({ type: 'TACTIC_RESOLVED', itemId: item.id, cardId: item.payload.cardId });
  }
}

// ------------------------------------------------------------
// ABILITIES / EFFECTS (Taktiky)
// ------------------------------------------------------------

function resolveAbilityEffect(state, sourcePlayerId, ability, targets, events) {
  const eff = ability.effect;
  if (!eff || !eff.kind) {
    events.push({ type: 'ABILITY_NO_EFFECT', abilityId: ability.id ?? null });
    return;
  }

  const duration = ability.duration ?? Duration.INSTANT;

  switch (eff.kind) {
    case 'FORCE_MELEE_ONLY': {
      const targetId = normalizeSingleTarget(targets);
      if (!targetId) {
        events.push({ type: 'ERROR', message: 'FORCE_MELEE_ONLY requires a single target warrior' });
        return;
      }
      state.combat.forcedMeleeOnly.add(targetId);
      events.push({ type: 'COMBAT_FLAG_SET', flag: 'FORCE_MELEE_ONLY', targetWarriorId: targetId, duration });
      return;
    }

    case 'DESTROY_EQUIPMENT': {
      const equipmentId = normalizeSingleTarget(targets);
      if (!equipmentId) {
        events.push({ type: 'ERROR', message: 'DESTROY_EQUIPMENT requires a single equipment cardInstanceId' });
        return;
      }
      destroyEquipmentInstance(state, equipmentId, events);
      return;
    }

    case 'ADD_MOD': {
      const targetId = normalizeSingleTarget(targets);
      if (!targetId) {
        events.push({ type: 'ERROR', message: 'ADD_MOD requires a single target warrior' });
        return;
      }
      addModifier(state, {
        targetWarriorId: targetId,
        stat: eff.stat,
        value: eff.value,
        source: { playerId: sourcePlayerId, abilityId: ability.id ?? null },
        duration,
      }, events);
      return;
    }

    case 'ADD_MOD_BUNDLE': {
      const targetId = normalizeSingleTarget(targets);
      if (!targetId || !Array.isArray(eff.mods)) {
        events.push({ type: 'ERROR', message: 'ADD_MOD_BUNDLE requires a target warrior and mods[]' });
        return;
      }
      for (const m of eff.mods) {
        addModifier(state, {
          targetWarriorId: targetId,
          stat: m.stat,
          value: m.value,
          source: { playerId: sourcePlayerId, abilityId: ability.id ?? null },
          duration,
        }, events);
      }
      return;
    }

    default:
      events.push({ type: 'ABILITY_EFFECT_UNSUPPORTED', kind: eff.kind });
  }
}

// ------------------------------------------------------------
// MODIFIERS
// ------------------------------------------------------------

function addModifier(state, { targetWarriorId, stat, value, source, duration }, events) {
  const w = state.entities.warriors[targetWarriorId];
  if (!w) {
    events.push({ type: 'ERROR', message: 'Modifier target not found' });
    return;
  }

  const modId = genId('mod');
  const mod = {
    id: modId,
    targetWarriorId,
    stat,
    value,
    source,
    duration,
    expiresAt: computeExpiresAt(state, duration),
  };

  w.modifiers.push({ id: modId, stat, value });
  state.effects.modifiers.push(mod);
  events.push({ type: 'MODIFIER_ADDED', modId, targetWarriorId, stat, value, duration });
}

function removeModifiersBySourceCardInstance(state, sourceCardInstanceId, events) {
  const toRemove = state.effects.modifiers.filter(m => m?.source?.cardInstanceId === sourceCardInstanceId);
  for (const m of toRemove) {
    const w = state.entities.warriors[m.targetWarriorId];
    if (w) w.modifiers = w.modifiers.filter(x => x.id !== m.id);
    state.effects.modifiers = state.effects.modifiers.filter(x => x.id !== m.id);
    events.push({ type: 'MODIFIER_REMOVED_BY_SOURCE', modId: m.id, sourceCardInstanceId, targetWarriorId: m.targetWarriorId });
  }
}

function removeAllModifiersOnTarget(state, targetWarriorId) {
  const w = state.entities.warriors[targetWarriorId];
  if (!w) return;
  const all = state.effects.modifiers.filter(m => m.targetWarriorId === targetWarriorId);
  for (const m of all) {
    w.modifiers = w.modifiers.filter(x => x.id !== m.id);
    state.effects.modifiers = state.effects.modifiers.filter(x => x.id !== m.id);
  }
}

function computeExpiresAt(state, duration) {
  if (duration === Duration.PERMANENT) return null;
  if (duration === Duration.INSTANT) return { when: 'IMMEDIATE' };
  if (duration === Duration.UNTIL_END_OF_TURN) return { when: 'END_OF_TURN', turn: state.turn.number };
  if (duration === Duration.UNTIL_END_OF_ROUND) return { when: 'END_OF_ROUND', round: state.turn.number };
  return null;
}

// ------------------------------------------------------------
// COMBAT
// ------------------------------------------------------------

function resolveAttack(state, attackAction, events) {
  const { playerId, attackerId, targetType, targetId, mode } = attackAction;

  const clearCombatFlags = () => {
    state.combat.forcedMeleeOnly.clear();
  };

  const attacker = state.entities.warriors[attackerId];
  if (!attacker || attacker.owner !== playerId || attacker.zone !== 'DRUZSTVO') {
    events.push({ type: 'ERROR', message: 'Invalid attacker' });
    clearCombatFlags();
    return;
  }

  if (targetType === 'PLAYER') {
    const opp = other(playerId);
    const oppHasDefenders = state.players[opp].board.some(wid => state.entities.warriors[wid]?.zone === 'DRUZSTVO');
    if (oppHasDefenders) {
      events.push({ type: 'ERROR', message: 'Direct attack not allowed while opponent has warriors' });
      clearCombatFlags();
      return;
    }

    const delta = attacker.base.H ?? 0;
    state.players[playerId].BV += delta;
    events.push({ type: 'BV_CHANGED', playerId, delta });
    events.push({ type: 'DIRECT_ATTACK_RESOLVED', attackerId, gainedBV: delta });
    clearCombatFlags();
    return;
  }

  const defender = state.entities.warriors[targetId];
  if (!defender || defender.owner === playerId || defender.zone !== 'DRUZSTVO') {
    events.push({ type: 'ERROR', message: 'Invalid defender' });
    clearCombatFlags();
    return;
  }

  const forcedMelee = state.combat.forcedMeleeOnly.has(defender.id);

  if (mode === 'S') {
    if (forcedMelee) {
      events.push({ type: 'ATTACK_MODE_FORCED', from: 'S', to: 'Z', reason: 'FORCE_MELEE_ONLY', defenderId: defender.id });
      const hitToDef = computeMeleeHit(attacker, defender);
      const hitToAtt = computeMeleeHit(defender, attacker);
      events.push({ type: 'MELEE_CHECK', attackerId, defenderId: defender.id, hitToDef, hitToAtt, forced: true });
      if (hitToDef) applyHit(state, playerId, defender.id, events);
      if (hitToAtt) applyHit(state, defender.owner, attacker.id, events);
      clearCombatFlags();
      return;
    }

    const hit = computeRangedHit(attacker, defender);
    events.push({ type: 'RANGED_CHECK', attackerId, defenderId: defender.id, hit });
    if (hit) applyHit(state, playerId, defender.id, events);
    clearCombatFlags();
    return;
  }

  if (mode === 'Z') {
    const hitToDef = computeMeleeHit(attacker, defender);
    const hitToAtt = computeMeleeHit(defender, attacker);
    events.push({ type: 'MELEE_CHECK', attackerId, defenderId: defender.id, hitToDef, hitToAtt });
    if (hitToDef) applyHit(state, playerId, defender.id, events);
    if (hitToAtt) applyHit(state, defender.owner, attacker.id, events);
    clearCombatFlags();
    return;
  }

  events.push({ type: 'ERROR', message: 'Unknown attack mode' });
  clearCombatFlags();
}

function computeRangedHit(attacker, defender) {
  return finalStat(attacker, 'S') > finalStat(defender, 'O');
}

function computeMeleeHit(attacker, defender) {
  return finalStat(attacker, 'Z') > finalStat(defender, 'O');
}

function finalStat(warrior, stat) {
  const base = warrior.base?.[stat] ?? 0;
  const modSum = (warrior.modifiers ?? []).reduce((s, m) => s + (m.stat === stat ? (m.value ?? 0) : 0), 0);
  return base + modSum;
}

function applyHit(state, sourcePlayerId, targetWarriorId, events) {
  const target = state.entities.warriors[targetWarriorId];
  if (!target) return;

  events.push({ type: 'WARRIOR_HIT', sourcePlayerId, targetId: targetWarriorId });

  if (!target.damaged) {
    target.damaged = true;
    events.push({ type: 'WARRIOR_DAMAGED_SET', targetId: targetWarriorId, damaged: true });
  } else {
    killWarrior(state, sourcePlayerId, targetWarriorId, events);
  }
}

function killWarrior(state, killerPlayerId, targetWarriorId, events) {
  const target = state.entities.warriors[targetWarriorId];
  if (!target) return;

  moveAttachmentsToGrave(state, target, events);
  removeAllModifiersOnTarget(state, targetWarriorId);
  moveWarriorZone(state, targetWarriorId, 'HRBITOV', events);

  const delta = target.base?.H ?? 0;
  state.players[killerPlayerId].BV += delta;
  events.push({ type: 'BV_CHANGED', playerId: killerPlayerId, delta });

  events.push({ type: 'WARRIOR_DIED', targetId: targetWarriorId, killerPlayerId });
}

// ------------------------------------------------------------
// PLAY / ATTACH / LOCATION / EVENTS
// ------------------------------------------------------------

function spawnWarrior(state, playerId, cardInstanceId, def, events) {
  removeFromArray(state.players[playerId].hand, cardInstanceId);

  const base = getBaseStats(def);
  const warriorId = genId('w');
  const abilityText = def.ability ?? '';

  state.entities.warriors[warriorId] = {
    id: warriorId,
    owner: playerId,
    cardInstanceId,
    cardId: def.id ?? getCardIdFromInstance(cardInstanceId),
    faction: def.faction ?? null,
    ability: abilityText,
    base: { ...base },
    damaged: false,
    modifiers: [],
    flags: {
      DRONE: hasDroneText(abilityText),
      MECH: hasMechText(abilityText),
      VOID_PHANTOM: isVoidFaction(def.faction) && hasPhantomText(abilityText),
      ENGINEER_REPAIR: hasEngineerRepairAbility(abilityText),
    },
    attachments: { equipment: [], darkGifts: [], arts: [], quest: null },
    zone: 'DRUZSTVO',
  };

  state.players[playerId].board.push(warriorId);
  events.push({ type: 'CARD_MOVED', cardInstanceId, from: 'HAND', to: 'BOARD', cardType: 'BOJOVNIK' });
  events.push({ type: 'WARRIOR_SPAWNED', warriorId, playerId, cardId: def.id ?? null });
}

function attachCardToWarrior(state, playerId, cardInstanceId, attachDef, targetWarriorId, events) {
  const attachType = normType(attachDef.type);
  const w = state.entities.warriors[targetWarriorId];
  if (!w) return;

  // zákaz dron/mech podle textu vybavení
  if (attachType === 'VYBAVENI') {
    const forbid = equipmentForbidsDroneOrMech(attachDef.ability);
    const isDrone = w.flags?.DRONE === true;
    const isMech = w.flags?.MECH === true;
    if ((forbid.forbidDrone && isDrone) || (forbid.forbidMech && isMech)) {
      events.push({ type: 'ERROR', message: 'Toto Vybavení nelze připojit na tento typ jednotky (dron/mech).' });
      return;
    }
  }

  removeFromArray(state.players[playerId].hand, cardInstanceId);

  if (attachType === 'VYBAVENI') w.attachments.equipment.push(cardInstanceId);
  if (attachType === 'TEMNY_DAR') w.attachments.darkGifts.push(cardInstanceId);
  if (attachType === 'UKOL') w.attachments.quest = cardInstanceId;

  // bonusy vybavení
  if (attachType === 'VYBAVENI') {
    const abilities = Array.isArray(attachDef.abilities) ? attachDef.abilities : [];
    const onAttach = abilities.filter(a => String(a.trigger || '').toUpperCase() === 'ON_ATTACH');

    if (onAttach.length > 0) {
      for (const ab of onAttach) {
        if (ab?.effect?.kind === 'ADD_MOD') {
          addModifier(state, {
            targetWarriorId,
            stat: ab.effect.stat,
            value: ab.effect.value,
            source: { kind: 'EQUIPMENT', cardInstanceId },
            duration: ab.duration || Duration.PERMANENT,
          }, events);
        } else if (ab?.effect?.kind === 'ADD_MOD_BUNDLE' && Array.isArray(ab.effect.mods)) {
          for (const m of ab.effect.mods) {
            addModifier(state, {
              targetWarriorId,
              stat: m.stat,
              value: m.value,
              source: { kind: 'EQUIPMENT', cardInstanceId },
              duration: ab.duration || Duration.PERMANENT,
            }, events);
          }
        }
      }
    } else {
      const mods = parseStatBonusesFromText(attachDef.ability);
      for (const m of mods) {
        if (m.value === 0) continue;
        addModifier(state, {
          targetWarriorId,
          stat: m.stat,
          value: m.value,
          source: { kind: 'EQUIPMENT', cardInstanceId },
          duration: Duration.PERMANENT,
        }, events);
      }
    }
  }

  events.push({ type: 'CARD_MOVED', cardInstanceId, from: 'HAND', to: 'ATTACHED', cardType: attachType });
  events.push({ type: 'CARD_ATTACHED', cardInstanceId, targetWarriorId, attachType });
}

function playLocation(state, playerId, cardInstanceId, events) {
  // (zatím beze změn)
  removeFromArray(state.players[playerId].hand, cardInstanceId);

  if (state.players[playerId].location) {
    const old = state.players[playerId].location;
    state.players[playerId].grave.push(old);
    events.push({ type: 'CARD_MOVED', cardInstanceId: old, from: 'LOCATION', to: 'GRAVE', cardType: 'LOKACE' });
  }

  state.players[playerId].location = cardInstanceId;
  events.push({ type: 'CARD_MOVED', cardInstanceId, from: 'HAND', to: 'LOCATION', cardType: 'LOKACE' });
}

function playGlobalEvent(state, playerId, cardInstanceId, def, events) {
  // odeber z ruky
  removeFromArray(state.players[playerId].hand, cardInstanceId);

  // pokud je stará událost aktivní, vyřaď ji
  if (state.globalEvent) {
    const old = state.globalEvent;
    state.players[old.ownerPlayerId].grave.push(old.cardInstanceId);
    events.push({ type: 'GLOBAL_EVENT_DISCARDED', cardInstanceId: old.cardInstanceId });
  }

  const cardId = def.id ?? getCardIdFromInstance(cardInstanceId);

  // detekce konkrétní události: "Mlha nenadání" (text-based)
  const eff = deriveGlobalEventEffects(def);

  // do začátku dalšího kola = do začátku příštího tahu stejného hráče (při standardním střídání => +2)
  const expiresAtTurnNumber = state.turn.number + 2;

  state.globalEvent = {
    cardInstanceId,
    cardId,
    ownerPlayerId: playerId,
    expiresAtTurnNumber,
    effects: eff,
  };

  events.push({ type: 'GLOBAL_EVENT_PLAYED', cardInstanceId, cardId, ownerPlayerId: playerId, expiresAtTurnNumber, effects: eff });
}

function deriveGlobalEventEffects(def) {
  const t = simplifyText(def.ability || '') + ' ' + simplifyText(def.name || '');

  // Mlha nenadání: blok útoku + blok pohybu do/ven z Prázdnoty
  const isMist = t.includes('mlha') && t.includes('nenadan');
  if (isMist) {
    return { noAttack: true, noVoidMove: true };
  }

  // Default: žádný globální lock
  return { noAttack: false, noVoidMove: false };
}

function moveAttachmentsToGrave(state, warrior, events) {
  const p = state.players[warrior.owner];

  const all = [
    ...(warrior.attachments.equipment ?? []),
    ...(warrior.attachments.darkGifts ?? []),
  ];
  if (warrior.attachments.quest) all.push(warrior.attachments.quest);

  for (const inst of all) {
    p.grave.push(inst);
    events.push({ type: 'CARD_MOVED', cardInstanceId: inst, from: 'ATTACHED', to: 'GRAVE' });
  }

  warrior.attachments.equipment = [];
  warrior.attachments.darkGifts = [];
  warrior.attachments.quest = null;
}

function findEquipmentOwner(state, equipmentInstanceId) {
  for (const w of Object.values(state.entities.warriors)) {
    const eq = w?.attachments?.equipment;
    if (Array.isArray(eq) && eq.includes(equipmentInstanceId)) return w;
  }
  return null;
}

function destroyEquipmentInstance(state, equipmentInstanceId, events) {
  const ownerWarrior = findEquipmentOwner(state, equipmentInstanceId);
  if (!ownerWarrior) {
    events.push({ type: 'ERROR', message: 'Equipment not found on any warrior' });
    return false;
  }

  ownerWarrior.attachments.equipment = ownerWarrior.attachments.equipment.filter(e => e !== equipmentInstanceId);
  removeModifiersBySourceCardInstance(state, equipmentInstanceId, events);

  state.players[ownerWarrior.owner].grave.push(equipmentInstanceId);
  events.push({ type: 'EQUIPMENT_DESTROYED', equipmentId: equipmentInstanceId, ownerWarriorId: ownerWarrior.id, ownerPlayerId: ownerWarrior.owner });
  events.push({ type: 'CARD_MOVED', cardInstanceId: equipmentInstanceId, from: 'ATTACHED', to: 'GRAVE', cardType: 'VYBAVENI' });
  return true;
}

// ------------------------------------------------------------
// TURN ADVANCE
// ------------------------------------------------------------

function endTurnAfterAttack(state, events) {
  events.push({ type: 'TURN_END_BY_ATTACK', playerId: state.turn.activePlayer });
  endTurnCommon(state, events);
}

function endTurnCommon(state, events) {
  // přepnutí hráče
  state.turn.activePlayer = other(state.turn.activePlayer);
  state.turn.number += 1;
  state.turn.actionsLeft = 3;
  state.turn.canAttack = state.turn.number > 1;

  // vypršení globální události (kontrolujeme na začátku tahu)
  expireGlobalEventIfNeeded(state, events);

  // dobrání do 7
  drawUpTo(state, state.turn.activePlayer, 7);

  events.push({ type: 'TURN_STARTED', playerId: state.turn.activePlayer, turnNumber: state.turn.number });
}

function expireGlobalEventIfNeeded(state, events) {
  const ge = state.globalEvent;
  if (!ge) return;

  // vyprší na začátku tahu, jehož turn.number je >= expiresAtTurnNumber
  if (state.turn.number >= ge.expiresAtTurnNumber) {
    state.players[ge.ownerPlayerId].grave.push(ge.cardInstanceId);
    events.push({ type: 'GLOBAL_EVENT_EXPIRED', cardInstanceId: ge.cardInstanceId, cardId: ge.cardId });
    state.globalEvent = null;
  }
}

// ------------------------------------------------------------
// GLOBAL EVENT LOCKS
// ------------------------------------------------------------

function isNoAttackActive(state) {
  return state.globalEvent?.effects?.noAttack === true;
}

function isNoVoidMoveActive(state) {
  return state.globalEvent?.effects?.noVoidMove === true;
}

// ------------------------------------------------------------
// UTIL
// ------------------------------------------------------------

function simplifyText(s) {
  const t = String(s || '');
  return t
    .toLowerCase()
    .replaceAll('í', 'i').replaceAll('á', 'a').replaceAll('é', 'e').replaceAll('ó', 'o')
    .replaceAll('ú', 'u').replaceAll('ů', 'u').replaceAll('ý', 'y')
    .replaceAll('č', 'c').replaceAll('ď', 'd').replaceAll('ě', 'e').replaceAll('ň', 'n')
    .replaceAll('ř', 'r').replaceAll('š', 's').replaceAll('ť', 't').replaceAll('ž', 'z');
}

function hasDroneText(abilityText) {
  return simplifyText(abilityText).includes('dron');
}

function hasMechText(abilityText) {
  return simplifyText(abilityText).includes('mech');
}

function hasPhantomText(abilityText) {
  return simplifyText(abilityText).includes('prizrak');
}

function isVoidFaction(factionText) {
  const f = normFaction(factionText);
  return f.includes('void') || f.includes('prazdnot');
}

function hasEngineerRepairAbility(abilityText) {
  const t = simplifyText(abilityText);
  const hasTwoActions = (t.includes('2') && t.includes('akce')) || (t.includes('dve') && t.includes('akce'));
  const hasRepair = t.includes('oprav') || t.includes('uzdrav') || t.includes('vylec');
  return hasTwoActions && hasRepair && t.includes('dron') && t.includes('mech');
}

function parseStatBonusesFromText(abilityText) {
  const out = [];
  const t = String(abilityText || '');
  const re = /\+\s*(\d+)\s*k\s*([ZSO])/gi;
  let m;
  while ((m = re.exec(t)) !== null) {
    out.push({ stat: String(m[2]).toUpperCase(), value: toInt(m[1]) });
  }
  return out;
}

function toInt(x) {
  const n = Number.parseInt(x, 10);
  return Number.isFinite(n) ? n : 0;
}

function equipmentForbidsDroneOrMech(equipmentAbilityText) {
  const t = simplifyText(equipmentAbilityText);
  const hasCannot = t.includes('nemuze') && (t.includes('pridano') || t.includes('pridat'));
  return {
    forbidDrone: hasCannot && t.includes('dron'),
    forbidMech: hasCannot && t.includes('mech'),
  };
}

function normFaction(f) {
  return simplifyText(f).replaceAll('-', '').replaceAll(' ', '');
}

function determineStartingPlayer(state, cardDB) {
  const warriorsInHand = (pid) => state.players[pid].hand
    .map(getCardIdFromInstance)
    .map(id => cardDB[id])
    .filter(def => def && normType(def.type) === 'BOJOVNIK');

  const count = (pid) => warriorsInHand(pid).length;
  const sumH = (pid) => warriorsInHand(pid).reduce((s, def) => s + (getBaseStats(def).H ?? 0), 0);

  const cA = count('A');
  const cB = count('B');
  if (cA !== cB) return cA < cB ? 'A' : 'B';

  const hA = sumH('A');
  const hB = sumH('B');
  if (hA !== hB) return hA < hB ? 'A' : 'B';

  return 'A';
}

function drawUpTo(state, playerId, handLimit) {
  while (state.players[playerId].hand.length < handLimit && state.players[playerId].deck.length > 0) {
    const cardInstanceId = state.players[playerId].deck.shift();
    state.players[playerId].hand.push(cardInstanceId);
    state.log.push({ type: 'DRAW', playerId, cardInstanceId });
  }
}

function moveWarriorZone(state, warriorId, toZone, events) {
  const w = state.entities.warriors[warriorId];
  if (!w) return;
  const owner = w.owner;

  removeFromArray(state.players[owner].board, warriorId);
  removeFromArray(state.players[owner].void, warriorId);

  if (toZone === 'DRUZSTVO') {
    state.players[owner].board.push(warriorId);
    w.zone = 'DRUZSTVO';
  } else if (toZone === 'PRAZDNOTA') {
    state.players[owner].void.push(warriorId);
    w.zone = 'PRAZDNOTA';
  } else if (toZone === 'HRBITOV') {
    w.zone = 'HRBITOV';
    state.players[owner].grave.push(w.cardInstanceId);
    events.push({ type: 'CARD_MOVED', cardInstanceId: w.cardInstanceId, from: 'BOARD', to: 'GRAVE', cardType: 'BOJOVNIK' });
  }

  events.push({ type: 'WARRIOR_ZONE_CHANGED', warriorId, toZone });
}

function moveCardInstance(state, playerId, cardInstanceId, from, to, events, cardType) {
  if (from === 'HAND') removeFromArray(state.players[playerId].hand, cardInstanceId);
  if (to === 'GRAVE') state.players[playerId].grave.push(cardInstanceId);
  events.push({ type: 'CARD_MOVED', cardInstanceId, from, to, cardType });
}

function normalizeSingleTarget(targets) {
  if (!targets) return null;
  if (Array.isArray(targets)) return targets.length > 0 ? targets[0] : null;
  if (typeof targets === 'string') return targets;
  return null;
}

function ensureActions(state, n) {
  if (state.turn.actionsLeft < n) throw new Error('Not enough actions');
}

function ensureBO(state, playerId, n) {
  if (state.players[playerId].BO < n) throw new Error('Not enough BO');
}

function other(pid) {
  return pid === 'A' ? 'B' : 'A';
}

function removeFromArray(arr, item) {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

let _id = 1;
function genId(prefix) {
  return `${prefix}${_id++}`;
}

function getCardIdFromInstance(cardInstanceId) {
  const s = String(cardInstanceId);
  const idx = s.indexOf('::');
  return idx >= 0 ? s.slice(0, idx) : s;
}

function normType(type) {
  const t = String(type || '').toUpperCase();
  return t
    .replaceAll('Í', 'I')
    .replaceAll('Á', 'A')
    .replaceAll('É', 'E')
    .replaceAll('Ó', 'O')
    .replaceAll('Ú', 'U')
    .replaceAll('Ů', 'U')
    .replaceAll('Ý', 'Y')
    .replaceAll('Č', 'C')
    .replaceAll('Ď', 'D')
    .replaceAll('Ě', 'E')
    .replaceAll('Ň', 'N')
    .replaceAll('Ř', 'R')
    .replaceAll('Š', 'S')
    .replaceAll('Ť', 'T')
    .replaceAll('Ž', 'Z');
}

function isAttachType(t) {
  return t === 'VYBAVENI' || t === 'TEMNY_DAR' || t === 'UKOL';
}

function getBaseStats(def) {
  const base = def.base || null;
  if (base) {
    return {
      Z: base.Z ?? base.z ?? 0,
      S: base.S ?? base.s ?? 0,
      O: base.O ?? base.o ?? 0,
      H: base.H ?? base.h ?? 0,
    };
  }
  return {
    Z: def.Z ?? def.z ?? 0,
    S: def.S ?? def.s ?? 0,
    O: def.O ?? def.o ?? 0,
    H: def.H ?? def.h ?? 0,
  };
}
