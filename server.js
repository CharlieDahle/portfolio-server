const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Simple room storage - just data, no playback logic
const rooms = new Map();

class DrumRoom {
  constructor(id) {
    this.id = id;
    this.bpm = 120;
    this.measureCount = 4; // Add measure count to room state
    this.pattern = new Map(); // trackId -> Array of note objects {tick, velocity}
    this.tracks = new Map(); // trackId -> track data (name, color, soundFile, etc.)
    this.users = new Set();
    this.lastActivity = Date.now();

    // Initialize default tracks with empty patterns
    this.initializeDefaultTracks();
  }

  initializeDefaultTracks() {
    const defaultTracks = [
      {
        id: "kick",
        name: "Kick",
        color: "#e74c3c",
        soundFile: "kicks/Ac_K.wav",
        availableSounds: [],
      },
      {
        id: "snare",
        name: "Snare",
        color: "#f39c12",
        soundFile: "snares/Box_Snr2.wav",
        availableSounds: [],
      },
      {
        id: "hihat",
        name: "Hi-Hat",
        color: "#2ecc71",
        soundFile: "hihats/Jls_H.wav",
        availableSounds: [],
      },
      {
        id: "openhat",
        name: "Open Hat",
        color: "#3498db",
        soundFile: "cymbals/CL_OHH1.wav",
        availableSounds: [],
      },
    ];

    defaultTracks.forEach((track) => {
      this.tracks.set(track.id, track);
      this.pattern.set(track.id, []); // Array instead of Set
    });
  }

  addUser(userId) {
    this.users.add(userId);
    this.lastActivity = Date.now();
  }

  removeUser(userId) {
    this.users.delete(userId);
    this.lastActivity = Date.now();

    // Don't immediately delete empty rooms
    // Let the cleanup interval handle it after 2 minutes
    if (this.users.size === 0) {
      console.log(
        `Room ${this.id} is now empty - will cleanup in 2 minutes if no one rejoins`
      );
    }
  }

  // Add a note at specific tick position with velocity
  addNote(trackId, tick, velocity = 4) {
    if (!this.pattern.has(trackId)) {
      this.pattern.set(trackId, []);
    }

    const trackNotes = this.pattern.get(trackId);

    // Check if note already exists at this tick
    const existingNoteIndex = trackNotes.findIndex(
      (note) => note.tick === tick
    );

    if (existingNoteIndex === -1) {
      // Add new note
      trackNotes.push({ tick, velocity: Math.max(1, Math.min(4, velocity)) });
      this.lastActivity = Date.now();
    }
    // If note exists, don't add duplicate
  }

  // Remove a note from specific tick position
  removeNote(trackId, tick) {
    if (this.pattern.has(trackId)) {
      const trackNotes = this.pattern.get(trackId);
      const filteredNotes = trackNotes.filter((note) => note.tick !== tick);
      this.pattern.set(trackId, filteredNotes);
      this.lastActivity = Date.now();
    }
  }

  // Update note velocity
  updateNoteVelocity(trackId, tick, velocity) {
    if (this.pattern.has(trackId)) {
      const trackNotes = this.pattern.get(trackId);
      const noteIndex = trackNotes.findIndex((note) => note.tick === tick);

      if (noteIndex !== -1) {
        trackNotes[noteIndex].velocity = Math.max(1, Math.min(4, velocity));
        this.lastActivity = Date.now();
      }
    }
  }

  // Move a note from one position to another
  moveNote(trackId, fromTick, toTick) {
    if (this.pattern.has(trackId)) {
      const trackNotes = this.pattern.get(trackId);
      const noteIndex = trackNotes.findIndex((note) => note.tick === fromTick);

      if (noteIndex !== -1) {
        const noteToMove = trackNotes[noteIndex];
        // Remove from old position
        trackNotes.splice(noteIndex, 1);
        // Add at new position
        trackNotes.push({ ...noteToMove, tick: toTick });
        this.lastActivity = Date.now();
      }
    }
  }

  // Clear entire track
  clearTrack(trackId) {
    if (this.pattern.has(trackId)) {
      this.pattern.set(trackId, []);
      this.lastActivity = Date.now();
    }
  }

  // Get current room state for sending to clients
  getState() {
    // Convert pattern Map to object with arrays
    const serializedPattern = {};
    for (const [trackId, noteArray] of this.pattern.entries()) {
      serializedPattern[trackId] = noteArray; // Already an array
    }

    // Convert tracks Map to Array
    const serializedTracks = Array.from(this.tracks.values());

    return {
      id: this.id,
      bpm: this.bpm,
      measureCount: this.measureCount,
      pattern: serializedPattern,
      tracks: serializedTracks,
      users: Array.from(this.users),
    };
  }

  setBpm(newBpm) {
    this.bpm = Math.max(60, Math.min(300, newBpm)); // Clamp between 60-300
    this.lastActivity = Date.now();
  }

  // Add measure count management
  setMeasureCount(newMeasureCount) {
    this.measureCount = Math.max(1, Math.min(16, newMeasureCount)); // Clamp between 1-16
    this.lastActivity = Date.now();
  }

  // Track management
  addTrack(trackData) {
    this.tracks.set(trackData.id, trackData);
    this.pattern.set(trackData.id, []); // Empty array for new track
    this.lastActivity = Date.now();
  }

  removeTrack(trackId) {
    this.tracks.delete(trackId);
    this.pattern.delete(trackId);
    this.lastActivity = Date.now();
  }

  updateTrackSound(trackId, newSoundFile) {
    if (this.tracks.has(trackId)) {
      const track = this.tracks.get(trackId);
      track.soundFile = newSoundFile;
      this.tracks.set(trackId, track);
      this.lastActivity = Date.now();
    }
  }
}

// Socket connection handling
io.on("connection", (socket) => {
  console.log(`[${new Date().toISOString()}] User connected: ${socket.id}`);

  socket.on("ping", () => {
    console.log(`[${new Date().toISOString()}] Ping from ${socket.id}`);
  });

  socket.on("pong", (latency) => {
    console.log(
      `[${new Date().toISOString()}] Pong from ${
        socket.id
      }, latency: ${latency}ms`
    );
  });

  // Create new room
  socket.on("create-room", (callback) => {
    const roomId = uuidv4().slice(0, 8);
    const room = new DrumRoom(roomId);
    rooms.set(roomId, room);

    socket.join(roomId);
    room.addUser(socket.id);

    console.log(`Room created: ${roomId} by ${socket.id}`);

    callback({
      success: true,
      roomId,
      roomState: room.getState(),
    });
  });

  // Join existing room
  socket.on("join-room", ({ roomId }, callback) => {
    const room = rooms.get(roomId);

    if (!room) {
      callback({ success: false, error: "Room not found" });
      return;
    }

    socket.join(roomId);
    room.addUser(socket.id);

    console.log(`User ${socket.id} joined room ${roomId}`);

    // Send current room state to joining user
    callback({
      success: true,
      roomState: room.getState(),
    });

    // Notify other users in room
    socket.to(roomId).emit("user-joined", {
      userId: socket.id,
      userCount: room.users.size,
    });
  });

  // Handle pattern changes
  socket.on("pattern-change", ({ roomId, change }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid pattern change request:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Pattern change in room ${roomId}:`, change);

    // Apply the change to room state
    switch (change.type) {
      case "add-note":
        room.addNote(change.trackId, change.tick, change.velocity);
        break;

      case "remove-note":
        room.removeNote(change.trackId, change.tick);
        break;

      case "update-note-velocity":
        room.updateNoteVelocity(change.trackId, change.tick, change.velocity);
        break;

      case "move-note":
        room.moveNote(change.trackId, change.fromTick, change.toTick);
        break;

      case "clear-track":
        room.clearTrack(change.trackId);
        break;

      default:
        console.log(`Unknown pattern change type: ${change.type}`);
        return;
    }

    // Broadcast change to all users in room (excluding sender)
    socket.to(roomId).emit("pattern-update", change);
  });

  // Handle transport commands (play/pause/stop)
  socket.on("transport-command", ({ roomId, command }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid transport command:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Transport command in room ${roomId}:`, command);

    // Add high-precision timestamp for sync
    const syncCommand = {
      ...command,
      timestamp: Date.now(),
    };

    // Broadcast to all users in room with timestamp
    socket.to(roomId).emit("transport-sync", syncCommand);
  });

  // Handle BPM changes
  socket.on("set-bpm", ({ roomId, bpm }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid BPM change:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`BPM change in room ${roomId}: ${room.bpm} -> ${bpm}`);

    room.setBpm(bpm);

    // Broadcast BPM change to all users
    socket.to(roomId).emit("bpm-change", {
      bpm: room.bpm,
      timestamp: Date.now(),
    });
  });

  // Handle measure count changes
  socket.on("set-measure-count", ({ roomId, measureCount }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid measure count change:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(
      `Measure count change in room ${roomId}: ${room.measureCount} -> ${measureCount}`
    );

    room.setMeasureCount(measureCount);

    // Broadcast measure count change to all users
    socket.to(roomId).emit("measure-count-change", {
      measureCount: room.measureCount,
      timestamp: Date.now(),
    });
  });

  // Handle track addition
  socket.on("add-track", ({ roomId, trackData }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid add track request:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track added in room ${roomId}:`, trackData);

    room.addTrack(trackData);

    // Broadcast track addition to all users (excluding sender)
    socket.to(roomId).emit("track-added", {
      trackData,
      timestamp: Date.now(),
    });
  });

  // Handle track removal
  socket.on("remove-track", ({ roomId, trackId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid remove track request:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Track removed in room ${roomId}:`, trackId);

    room.removeTrack(trackId);

    // Broadcast track removal to all users (excluding sender)
    socket.to(roomId).emit("track-removed", {
      trackId,
      timestamp: Date.now(),
    });
  });

  // Handle track sound changes
  socket.on("update-track-sound", ({ roomId, trackId, soundFile }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid track sound update:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Track sound updated in room ${roomId}:`, {
      trackId,
      soundFile,
    });

    room.updateTrackSound(trackId, soundFile);

    // Broadcast sound change to all users (excluding sender)
    socket.to(roomId).emit("track-sound-updated", {
      trackId,
      soundFile,
      timestamp: Date.now(),
    });
  });

  // ============================================================================
  // DYNAMIC EFFECTS SYSTEM
  // ============================================================================

  // Handle effect chain updates (complete enabled effects state)
  socket.on("effect-chain-update", ({ roomId, trackId, enabledEffects }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid effect chain update:`, {
        roomId,
        userId: socket.id,
      });
      return;
    }

    console.log(`Effect chain update in room ${roomId}:`, {
      trackId,
      enabledEffects,
    });

    // Broadcast effect chain update to all users (excluding sender)
    socket.to(roomId).emit("effect-chain-update", {
      trackId,
      enabledEffects,
      timestamp: Date.now(),
    });
  });

  // Handle effect reset (clears all effects for a track)
  socket.on("effect-reset", ({ roomId, trackId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid effect reset:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`Effect reset in room ${roomId}:`, trackId);

    // Broadcast effect reset to all users (excluding sender)
    socket.to(roomId).emit("effect-reset", {
      trackId,
      timestamp: Date.now(),
    });
  });

  // Get current room state (for periodic sync if needed)
  socket.on("get-room-state", ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) {
      callback({ success: true, roomState: room.getState() });
    } else {
      callback({ success: false, error: "Room not found or not a member" });
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(
      `[${new Date().toISOString()}] User disconnected: ${socket.id}`
    );

    // Remove user from all rooms they were in
    rooms.forEach((room, roomId) => {
      if (room.users.has(socket.id)) {
        room.removeUser(socket.id);

        // Notify remaining users
        socket.to(roomId).emit("user-left", {
          userId: socket.id,
          userCount: room.users.size,
        });
      }
    });
  });

  socket.on("leave-room", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) {
      console.log(`Invalid leave room request:`, { roomId, userId: socket.id });
      return;
    }

    console.log(`User ${socket.id} left room ${roomId}`);

    // Remove user from room but keep socket connection alive
    socket.leave(roomId);
    room.removeUser(socket.id);

    // Notify remaining users in room
    socket.to(roomId).emit("user-left", {
      userId: socket.id,
      userCount: room.users.size,
    });
  });

  socket.on("error", (err) => {
    console.error(`[${new Date().toISOString()}] Socket error:`, err.message);
  });
});

// Updated cleanup with 2-minute grace period for empty rooms only
setInterval(() => {
  const now = Date.now();
  const EMPTY_ROOM_TIMEOUT = 1000 * 60 * 2; // 2 minutes for empty rooms

  rooms.forEach((room, roomId) => {
    // Only clean up empty rooms after 2 minutes
    if (room.users.size === 0 && now - room.lastActivity > EMPTY_ROOM_TIMEOUT) {
      rooms.delete(roomId);
      console.log(`Cleaned up empty room: ${roomId} (empty for 2+ minutes)`);
    }
    // Active rooms with users are NEVER auto-deleted
  });
}, 1000 * 30); // Check every 30 seconds

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(
    `Drum server with 2-minute room persistence running on port ${PORT}`
  );
  console.log(
    `Room cleanup: Empty rooms deleted after 2 minutes, active rooms persist indefinitely`
  );
});
