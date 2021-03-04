import { on, EventEmitter } from 'events'

import minecraft_data from 'minecraft-data'
import UUID from 'uuid-1345'
import { aiter } from 'iterator-helper'

import { chunk_position, same_chunk, chunk_index } from '../chunk.js'
import { version } from '../settings.js'
import { is_inside } from '../math.js'

import { Types } from './types.js'
import { path_to_positions } from './path.js'

const { entitiesByName } = minecraft_data(version)

const color_by_type = {
  mob: 'white',
  archiMob: 'gold',
  boss: 'red',
  npc: 'green',
  garde: 'blue',
}

function write_mob(client, { mob: { entity_id, mob, level }, position }) {
  const { type, mob: entity_type, displayName } = Types[mob]

  client.write('spawn_entity_living', {
    entityId: entity_id,
    entityUUID: UUID.v4(),
    type: entitiesByName[entity_type].id,
    x: position.x,
    y: position.y,
    z: position.z,
    yaw: 0,
    pitch: 0,
    headPitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
  })

  client.write('entity_metadata', {
    entityId: entity_id,
    metadata: [
      {
        key: 2,
        type: 5,
        value: JSON.stringify({
          text: displayName,
          color: color_by_type[type],
          extra: level && [{ text: ` [Lvl ${level}]`, color: 'dark_red' }],
        }),
      },
      {
        key: 3,
        type: 7,
        value: true,
      },
    ],
  })
}

function emit_mob_movements(mobs) {
  const mob_movements = new EventEmitter()

  for (const mob of mobs.all) {
    const state = aiter(on(mob.events, 'state')).map(([state]) => state)

    const positions = path_to_positions(state)

    aiter(positions).reduce((last_position, position) => {
      if (last_position !== position) {
        const chunk_x = chunk_position(position.x)
        const chunk_z = chunk_position(position.z)

        mob_movements.emit(chunk_index(chunk_x, chunk_z), {
          mob,
          position,
          last_position,
        })

        if (!same_chunk(position, last_position)) {
          const last_chunk_x = chunk_position(last_position.x)
          const last_chunk_z = chunk_position(last_position.z)

          mob_movements.emit(chunk_index(last_chunk_x, last_chunk_z), {
            mob,
            position,
            last_position,
          })
        }
      }
      return position
    })
  }

  return mob_movements
}

export default function update_client(world) {
  const mob_movements = emit_mob_movements(world.mobs)

  return {
    observe({ client, events, world, get_state }) {
      function inside_view(position) {
        const { view_distance, position: player_position } = get_state()

        const player_chunk_x = chunk_position(player_position.x)
        const player_chunk_z = chunk_position(player_position.z)

        const chunk_x = chunk_position(position.x)
        const chunk_z = chunk_position(position.z)

        return is_inside(
          {
            min: {
              x: player_chunk_x - view_distance,
              y: player_chunk_z - view_distance,
            },
            max: {
              x: player_chunk_x + view_distance,
              y: player_chunk_z + view_distance,
            },
          },
          { x: chunk_x, y: chunk_z }
        )
      }

      const outside_view = (position) => !inside_view(position)

      events.on('chunk_loaded', ({ x, z }) => {
        const mobs = world.mobs.by_chunk(x, z)

        for (const mob of mobs)
          write_mob(client, { mob, position: mob.position() })

        const controller = new AbortController()

        aiter(on(events, 'chunk_unloaded'))
          .filter((chunk) => chunk.x === x && chunk.z === z)
          .take(1)
          .toArray()
          .then(() => controller.abort())

        aiter(
          on(mob_movements, chunk_index(x, z), { signal: controller.signal })
        )
          .reduce(
            (mob_ids, [{ mob, position, last_position }]) => {
              if (inside_view(position) && outside_view(last_position)) {
                write_mob(client, { mob, position })
                return [...mob_ids, mob.entity_id]
              }

              if (outside_view(position) && inside_view(last_position)) {
                client.write('entity_destroy', { entityIds: [mob.entity_id] })
                return mob_ids.filter(
                  (entity_id) => mob.entity_id !== entity_id
                )
              }

              const chunk_x = chunk_position(position.x)
              const chunk_z = chunk_position(position.z)

              if (chunk_x === x && chunk_z === z) {
                const delta_x = (position.x * 32 - last_position.x * 32) * 128
                const delta_y = (position.y * 32 - last_position.y * 32) * 128
                const delta_z = (position.z * 32 - last_position.z * 32) * 128

                client.write('rel_entity_move', {
                  entityId: mob.entity_id,
                  dX: delta_x,
                  dY: delta_y,
                  dZ: delta_z,
                  onGround: true,
                })
              }

              return mob_ids
            },
            mobs.map(({ entity_id }) => entity_id)
          )
          .then((entityIds) => client.write('entity_destroy', { entityIds }))
      })
    },
  }
}
