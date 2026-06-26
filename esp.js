// ==UserScript==
// @name         Gats.io ESP
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  Draws boxes around nearby players using WebSocket data
// @match        *://gats.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    // ── Configurable ──────────────────────────────────────────────
    const VEL_LINE_SCALE = 1;
    const WEAPON_LENGTH  = 100;
    // ──────────────────────────────────────────────────────────────

    let selfPlayer = [];
    let selfTeamCode = null;
    let selfId = null;
    let selfRadius = 20;
    let myBulletSpeed = 800;
    let playerPositions = {};
    let explosivePositions = {};
    let bulletPositions = {};
    let greenlistedUsernames = new Set();
    let overlayCtx = null;
    let scaleRatio = 1;

    const WEAPON_NAMES = {
        '0': 'pistol',
        '1': 'smg',
        '2': 'shotgun',
        '3': 'assault',
        '4': 'sniper',
        '5': 'lmg'
    };

    // Base sizes at scaleRatio=1 — scaled up at runtime by scaleRatio
    const EXPLOSIVE_SIZES = {
        'grenade':    20,
        'gasGrenade': 20,
        'landMine':   25,
        'fragGrenade':20
    };

    const EXPLOSIVE_LANDED_SIZES = {
        'grenade':    150,
        'gasGrenade': 180,
        'landMine':   25,
        'fragGrenade':150
    };

    const EXPLOSIVE_TYPE_MAP = {
        '0': 'grenade',
        '1': 'gasGrenade',
        '2': 'landMine',
        '3': 'fragGrenade'
    };

    function isTeammate(teamCode) {
        if (selfTeamCode === null || selfTeamCode === '0' || selfTeamCode === 0) return false;
        return String(teamCode) === String(selfTeamCode);
    }

    let mouseX = 0, mouseY = 0, mXt = 0, mYt = 0;
    document.addEventListener('mousemove', e => {
        mouseX = e.clientX;
        mouseY = e.clientY;
        if (overlayCtx) {
            const leanStrength = 13.6;
            mXt = (e.clientX - overlayCtx.canvas.width / 2) / leanStrength * scaleRatio;
            mYt = (e.clientY - overlayCtx.canvas.height / 2) / leanStrength * scaleRatio;
        }
    });

    let rightDown = false;
    let leftDown = false;
    let spaceActive = false;
    let leftUsedDuringRight = false;

    // Double right-click greenlist tracking
    let lastRightClickId   = null;
    let lastRightClickTime = 0;
    const DOUBLE_CLICK_MS  = 400;

    document.addEventListener('mousedown', e => {
        if (e.button === 2) {
            rightDown = true;
            leftUsedDuringRight = false;
        }

        if (e.button === 0) {
            leftDown = true;

            if (rightDown) {
                leftUsedDuringRight = true;
                e.stopImmediatePropagation(); e.stopPropagation(); e.preventDefault();

                if (!spaceActive) {
                    spaceActive = true;
                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true
                    }));
                }
            }
        }
    }, true);

    document.addEventListener('mouseup', e => {
        if (e.button === 0) {
            leftDown = false;

            if (spaceActive) {
                spaceActive = false;
                document.dispatchEvent(new KeyboardEvent('keyup', {
                    key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true
                }));
            }
        }

        if (e.button === 2) {
            rightDown = false;

            if (!leftUsedDuringRight) {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'r', code: 'KeyR', keyCode: 82, which: 82, bubbles: true
                }));
                setTimeout(() => {
                    document.dispatchEvent(new KeyboardEvent('keyup', {
                        key: 'r', code: 'KeyR', keyCode: 82, which: 82, bubbles: true
                    }));
                }, 50);
            }
        }
    });

    document.addEventListener('contextmenu', e => {
        if (!overlayCtx) return;
        e.preventDefault();
        if (rightDown) return;

        const canvas = overlayCtx.canvas;
        const wSF    = canvas.width  / canvas.offsetWidth;
        const hSF    = canvas.height / canvas.offsetHeight;
        const clickX = e.clientX * wSF;
        const clickY = e.clientY * hSF;

        let closestId   = null;
        let closestDist = 60;

        for (const [id, player] of Object.entries(playerPositions)) {
            const screen = worldToScreen(player.x, player.y, canvas);
            const dist   = Math.hypot(screen.x - clickX, screen.y - clickY);
            if (dist < closestDist) {
                closestDist = dist;
                closestId   = id;
            }
        }

        if (closestId === null) return;

        const now = Date.now();

        // Only greenlist on double right-click of the same player within DOUBLE_CLICK_MS
        if (closestId === lastRightClickId && now - lastRightClickTime < DOUBLE_CLICK_MS) {
            const username = playerPositions[closestId]?.username;
            if (username) {
                if (greenlistedUsernames.has(username)) {
                    greenlistedUsernames.delete(username);
                } else {
                    greenlistedUsernames.add(username);
                }
            }
            lastRightClickId   = null;
            lastRightClickTime = 0;
        } else {
            lastRightClickId   = closestId;
            lastRightClickTime = now;
        }
    });

    let camSpdX = 0, camSpdY = 0;
    let cDragX = 0, cDragY = 0;

    function updateAndGetCameraDrag() {
        if (selfPlayer[4]) {
            const playerSpdX = selfPlayer[4] / 10;
            const playerSpdY = selfPlayer[5] / 10;

            if (camSpdX < playerSpdX) camSpdX += 0.1;
            else if (camSpdX > playerSpdX) camSpdX -= 0.1;

            if (camSpdY < playerSpdY) camSpdY += 0.1;
            else if (camSpdY > playerSpdY) camSpdY -= 0.1;

            if (camSpdX > -0.1 && camSpdX < 0.1) camSpdX = 0;
            if (camSpdY > -0.1 && camSpdY < 0.1) camSpdY = 0;

            camSpdX = Math.round(camSpdX * 10) / 10;
            camSpdY = Math.round(camSpdY * 10) / 10;
        }
        return { x: camSpdX * 12.75 * scaleRatio, y: camSpdY * 12.75 * scaleRatio };
    }

    const OriginalWebSocket = window.WebSocket;

    window.WebSocket = function(url, protocols) {
        const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
        if (typeof url === "string" && url.includes("gats.io") && !url.includes("/ping")) {
            console.log("Target websocket detected:", url);
            interceptSocket(ws);
        }
        return ws;
    };

    window.WebSocket.prototype = OriginalWebSocket.prototype;

    function worldToScreen(worldX, worldY, canvas) {
        const selfX = selfPlayer[2] / 10;
        const selfY = selfPlayer[3] / 10;
        const px = worldX / 10;
        const py = worldY / 10;
        const dx = (selfX - px) * scaleRatio;
        const dy = (selfY - py) * scaleRatio;
        return {
            x: canvas.width  / 2 - dx - mXt + cDragX,
            y: canvas.height / 2 - dy - mYt + cDragY
        };
    }

    function drawBox(screenX, screenY, weaponClass, greenlisted, velX, velY, canvas) {
        const width  = 40;
        const height = 40;
        const x = screenX - width  / 2;
        const y = screenY - height / 2;

        const color = greenlisted ? '0, 255, 0' : '255, 0, 0';

        overlayCtx.strokeStyle = `rgb(${color})`;
        overlayCtx.lineWidth = 2;
        overlayCtx.strokeRect(x, y, width, height);

        overlayCtx.beginPath();
        const centerX = canvas.width  / 2 - mXt + cDragX;
        const centerY = canvas.height / 2 - mYt + cDragY;
        const dist    = Math.hypot(screenX - centerX, screenY - centerY);
        const percent = Math.max(0, Math.min(1, 1 - (dist - 100) / (1500 - 100)));
        overlayCtx.strokeStyle = `rgba(${color}, ${0.5 * percent})`;
        overlayCtx.lineWidth   = 12 * percent;
        overlayCtx.moveTo(centerX, centerY);
        overlayCtx.lineTo(screenX, screenY);
        overlayCtx.stroke();

        if (weaponClass !== undefined) {
            const label = WEAPON_NAMES[weaponClass] || weaponClass;
            overlayCtx.font      = 'bold 12px monospace';
            overlayCtx.textAlign = 'center';
            overlayCtx.fillStyle = 'rgba(255,255,255,0.5)';
            overlayCtx.fillText(label, screenX + 1, y - 3);
            overlayCtx.font      = 'bold 11px monospace';
            overlayCtx.fillStyle = `rgb(${color})`;
            overlayCtx.fillText(label, screenX, y - 4);
        }

        if (!greenlisted && velX !== undefined && velY !== undefined) {
            const scaledVelX = velX * VEL_LINE_SCALE * scaleRatio;
            const scaledVelY = velY * VEL_LINE_SCALE * scaleRatio;
            const velEndX    = screenX + scaledVelX;
            const velEndY    = screenY + scaledVelY;

            overlayCtx.beginPath();
            overlayCtx.strokeStyle = 'rgba(255, 200, 0, 0.8)';
            overlayCtx.lineWidth   = 2;
            overlayCtx.moveTo(screenX, screenY);
            overlayCtx.lineTo(velEndX, velEndY);
            overlayCtx.stroke();

            overlayCtx.beginPath();
            overlayCtx.arc(velEndX, velEndY, 3, 0, Math.PI * 2);
            overlayCtx.fillStyle = 'rgba(255, 200, 0, 0.9)';
            overlayCtx.fill();
        }
    }

    function drawExplosive(screenX, screenY, explosive) {
        const elapsed = Date.now() - explosive.spawnTime;
        const landed  = elapsed >= explosive.travelTime || explosive.exploding || explosive.emitting;

        // Scale radius by scaleRatio so it matches game world size at any zoom
        const baseRadius = landed
            ? (EXPLOSIVE_LANDED_SIZES[explosive.type] || 35)
            : (EXPLOSIVE_SIZES[explosive.type]        || 20);
        const radius = baseRadius * scaleRatio;

        const friendly    = explosive.friendly;
        const fillColor   = friendly ? '0, 200, 0' : '255, 80, 0';
        const strokeColor = friendly ? '0, 255, 0' : '255, 80, 0';

        overlayCtx.beginPath();
        overlayCtx.arc(screenX, screenY, radius, 0, Math.PI * 2);
        overlayCtx.fillStyle = landed
            ? `rgba(${fillColor}, 0.3)`
            : `rgba(${fillColor}, 0.15)`;
        overlayCtx.fill();

        overlayCtx.beginPath();
        overlayCtx.arc(screenX, screenY, radius, 0, Math.PI * 2);
        overlayCtx.strokeStyle = `rgba(${strokeColor}, 0.9)`;
        overlayCtx.lineWidth   = landed ? 3 : 2;
        overlayCtx.stroke();

        overlayCtx.font      = 'bold 10px monospace';
        overlayCtx.textAlign = 'center';
        overlayCtx.fillStyle = `rgba(${strokeColor}, 0.9)`;
        overlayCtx.fillText(explosive.type, screenX, screenY - radius - 3);
    }

    function drawBullet(screenX, screenY) {
        overlayCtx.beginPath();
        overlayCtx.arc(screenX, screenY, 5, 0, Math.PI * 2);
        overlayCtx.fillStyle   = 'rgba(255, 0, 0, 0.7)';
        overlayCtx.fill();
        overlayCtx.strokeStyle = 'rgba(255, 0, 0, 0.9)';
        overlayCtx.lineWidth   = 1;
        overlayCtx.stroke();
    }

    function removePlayer(id) {
        delete playerPositions[id];
    }

    function interceptSocket(ws) {
        ws.addEventListener("message", function(event) {
            if (!overlayCtx) overlayCtx = setupOverlay();
            if (!overlayCtx) return;

            const data = event.data;
            if (!(data instanceof ArrayBuffer)) return;

            const bytes = new Uint8Array(data);
            if (bytes[0] === 46) return;

            const text    = new TextDecoder().decode(bytes);
            const objects = text.split("|");

            for (let i = 0; i < objects.length; i++) {
                const object = objects[i];
                const type   = object[0];

                if (type === 'a') {
                    const parts  = object.split(',');
                    selfTeamCode = parts[22];
                    selfId       = parts[1];
                    selfRadius   = parseFloat(parts[6]) / 10;

                } else if (type === 'b') {
                    if (objects[i + 2] && objects[i + 2][0] === 'f') {
                        selfPlayer = object.split(",");
                    } else {
                        const parts = object.split(',');
                        const id    = parts[1];
                        if (!playerPositions[id]) playerPositions[id] = { x: 0, y: 0, class: undefined };
                        playerPositions[id].x        = parts[2];
                        playerPositions[id].y        = parts[3];
                        playerPositions[id].spdX     = parseFloat(parts[4]);
                        playerPositions[id].spdY     = parseFloat(parts[5]);
                        playerPositions[id].angle    = parseFloat(parts[6]);
                        playerPositions[id].lastSeen = Date.now();
                    }

                } else if (type === 'd') {
                    const parts = object.split(',');
                    const id    = parts[1];
                    if (!playerPositions[id]) playerPositions[id] = { x: 0, y: 0 };
                    playerPositions[id].class    = parts[2];
                    playerPositions[id].username = parts[11];
                    playerPositions[id].teamCode = parts[16];
                    playerPositions[id].angle    = parseFloat(parts[7]);
                    playerPositions[id].radius   = parseFloat(parts[6]) / 10;
                    playerPositions[id].x        = parseFloat(parts[4]);
                    playerPositions[id].y        = parseFloat(parts[5]);
                    playerPositions[id].lastSeen = Date.now();

                } else if (type === 'e') {
                    removePlayer(object.split(',')[1]);

                } else if (type === 'g') {
                    const parts    = object.split(',');
                    const id       = parts[1];
                    const teamCode = parts[13];
                    const ownerId  = parts[12];
                    const spdX     = parseFloat(parts[7]);
                    const spdY     = parseFloat(parts[8]);

                    const isMine = String(ownerId) === String(selfId) || isTeammate(teamCode);

                    if (isMine) {
                        const spd = Math.hypot(spdX, spdY);
                        if (spd > 0) myBulletSpeed = spd;
                        delete bulletPositions[id];
                    } else {
                        bulletPositions[id] = {
                            x:        parseFloat(parts[2]),
                            y:        parseFloat(parts[3]),
                            spdX:     spdX,
                            spdY:     spdY,
                            lastSeen: Date.now()
                        };
                    }

                } else if (type === 'h') {
                    const parts = object.split(',');
                    const id    = parts[1];
                    if (bulletPositions[id]) {
                        bulletPositions[id].x        = parseFloat(parts[2]);
                        bulletPositions[id].y        = parseFloat(parts[3]);
                        bulletPositions[id].lastSeen = Date.now();
                    }

                } else if (type === 'i') {
                    delete bulletPositions[object.split(',')[1]];

                } else if (type === 'm') {
                    const parts   = object.split(',');
                    const id      = parts[1];
                    const ownerTc = parts[11];

                    explosivePositions[id] = {
                        type:       EXPLOSIVE_TYPE_MAP[parts[2]] || 'grenade',
                        x:          parseFloat(parts[3]),
                        y:          parseFloat(parts[4]),
                        spdX:       parseFloat(parts[5]),
                        spdY:       parseFloat(parts[6]),
                        travelTime: parseInt(parts[7]) * 50,
                        spawnTime:  Date.now(),
                        exploding:  false,
                        emitting:   false,
                        friendly:   isTeammate(ownerTc),
                        lastSeen:   Date.now()
                    };

                } else if (type === 'n') {
                    const parts    = object.split(',');
                    const id       = parts[1];
                    const existing = explosivePositions[id];

                    explosivePositions[id] = {
                        type:           existing ? existing.type       : 'grenade',
                        travelTime:     existing ? existing.travelTime : 0,
                        spawnTime:      existing ? existing.spawnTime  : Date.now(),
                        friendly:       existing ? existing.friendly   : false,
                        x:              parseFloat(parts[2]),
                        y:              parseFloat(parts[3]),
                        exploding:      parts[4] === '1',
                        emitting:       parts[5] === '1',
                        emissionRadius: parseFloat(parts[6]),
                        lastSeen:       Date.now()
                    };

                } else if (type === 'o') {
                    delete explosivePositions[object.split(',')[1]];
                }
            }

            const now = Date.now();
            for (const id in playerPositions) {
                if (playerPositions[id].lastSeen && now - playerPositions[id].lastSeen > 3000) {
                    delete playerPositions[id];
                }
            }
            for (const id in explosivePositions) {
                if (explosivePositions[id].lastSeen && now - explosivePositions[id].lastSeen > 5000) {
                    delete explosivePositions[id];
                }
            }
            for (const id in bulletPositions) {
                if (bulletPositions[id].lastSeen && now - bulletPositions[id].lastSeen > 2000) {
                    delete bulletPositions[id];
                }
            }
        });

        ws.addEventListener('close', () => {
            for (const id in playerPositions)    delete playerPositions[id];
            for (const id in explosivePositions) delete explosivePositions[id];
            for (const id in bulletPositions)    delete bulletPositions[id];
            selfPlayer    = [];
            selfTeamCode  = null;
            selfId        = null;
            selfRadius    = 20;
            myBulletSpeed = 800;
            camSpdX = 0;
            camSpdY = 0;
        });
    }

    function drawLoop() {
        scaleRatio = document.getElementById('canvas')?.getContext('2d').getTransform().a || 1;
        const drag = updateAndGetCameraDrag();
        cDragX = drag.x;
        cDragY = drag.y;

        if (overlayCtx) {
            const canvas = overlayCtx.canvas;
            overlayCtx.clearRect(0, 0, canvas.width, canvas.height);

            const centerX = canvas.width  / 2 - mXt + cDragX;
            const centerY = canvas.height / 2 - mYt + cDragY;

            let closestEnemyId   = null;
            let closestEnemyDist = Infinity;

            Object.entries(playerPositions).forEach(([id, player]) => {
                const greenlisted = greenlistedUsernames.has(player.username) || isTeammate(player.teamCode);
                if (!greenlisted) {
                    const screen = worldToScreen(player.x, player.y, canvas);
                    const dist   = Math.hypot(screen.x - centerX, screen.y - centerY);
                    if (dist < closestEnemyDist) {
                        closestEnemyDist = dist;
                        closestEnemyId   = id;
                    }
                }
            });

            Object.values(bulletPositions).forEach(bullet => {
                const screen = worldToScreen(
                    bullet.x + (bullet.spdX || 0),
                    bullet.y + (bullet.spdY || 0),
                    canvas
                );
                drawBullet(screen.x, screen.y);
            });

            Object.values(explosivePositions).forEach(explosive => {
                const screen = worldToScreen(explosive.x, explosive.y, canvas);
                drawExplosive(screen.x, screen.y, explosive);
            });

            Object.entries(playerPositions).forEach(([id, player]) => {
                const screen      = worldToScreen(player.x, player.y, canvas);
                const greenlisted = greenlistedUsernames.has(player.username) || isTeammate(player.teamCode);
                const isClosest   = id === closestEnemyId;
                drawBox(screen.x, screen.y, player.class, greenlisted,
                    isClosest ? player.spdX : undefined,
                    isClosest ? player.spdY : undefined,
                    canvas);
            });
        }

        window.requestAnimationFrame(drawLoop);
    }

    window.requestAnimationFrame(drawLoop);
})();

function setupOverlay() {
    const gameCanvas = document.getElementById('canvas');
    if (!gameCanvas) return null;

    const overlay = document.createElement('canvas');

    function syncOverlay() {
        overlay.width  = gameCanvas.width;
        overlay.height = gameCanvas.height;
        overlay.style.top    = gameCanvas.offsetTop  + 'px';
        overlay.style.left   = gameCanvas.offsetLeft + 'px';
        overlay.style.width  = gameCanvas.offsetWidth  + 'px';
        overlay.style.height = gameCanvas.offsetHeight + 'px';
    }

    overlay.style.cssText = `
        position: absolute;
        pointer-events: none;
        z-index: 9999;
    `;

    syncOverlay();
    gameCanvas.parentNode.insertBefore(overlay, gameCanvas.nextSibling);

    const ro = new ResizeObserver(syncOverlay);
    ro.observe(gameCanvas);

    return overlay.getContext('2d');
}
