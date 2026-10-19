#!/usr/bin/env python3
"""Build the args files for 100 additional images and drive the batch pipeline.

Phase 1: generate in batches of 25 via connector__matrix__generate_image
Phase 2: resolve each success_item to a download URL and fetch it to ~/Pictures
Phase 3: validate headers and dimensions, write a manifest
"""
import json
import os
import subprocess
import sys
import time

DEST = "/home/dracon/Pictures"
REC_DIR = "/home/dracon/Dev/mcode-plugins/.dracon/h3-tasks"
BATCH_SIZE = 25

# (filename_stem, aspect_ratio, prompt)
ITEMS = [
    ("11_misty_mountain_valley", "16:9",
     "A vast misty mountain valley at sunrise, layered blue ridges fading into pale golden haze, low cloud filling the valley floor, a thin river catching the first light, distant peaks catching pink alpenglow, epic serene landscape photography, ultra detailed, high dynamic range, no text, no watermark"),
    ("12_desert_canyon_golden_hour", "16:9",
     "A towering sandstone canyon at golden hour, striated red rock walls glowing amber, a narrow sandy floor with wind-carved ripples, long dramatic shadows, a few visitors dwarfed at the base for scale, crisp desert light, cinematic wide landscape, no text, no watermark"),
    ("13_rice_terraces_mountains", "16:9",
     "Terraced rice fields stepping down a mountainside, flooded paddies mirroring a pink and gold dawn sky, thin irrigation channels glinting, distant misty mountains behind, a lone farmer in a conical hat on a ridge path, serene agrarian landscape photography, no text, no watermark"),
    ("14_northern_lights_fjord", "21:9",
     "Vivid green and violet aurora borealis arcing over a deep fjord, still black water reflecting the ribbons of light, steep bare mountains on either side, tiny cluster of red cabins on the shore giving scale, astrophotography, ultra wide, ultra detailed, no text, no watermark"),
    ("15_autumn_forest_road", "16:9",
     "A quiet country road winding through a forest in peak autumn, golden and crimson maple leaves carpeting the ground, dappled sunlight through the canopy, a wooden fence line along one side, wet fallen leaves, warm nostalgic mood, high detail landscape photography, no text, no watermark"),
    ("16_volcanic_black_sand_coast", "16:9",
     "A black volcanic sand beach with powerful white surf rolling in, jagged basalt sea stacks offshore, a green cliff edge in the distance, low heavy overcast light, fine mist blowing off the breakers, moody Icelandic coast photography, ultra detailed, no text, no watermark"),
    ("17_lavender_field_cypress", "16:9",
     "Rows of blooming lavender stretching to the horizon, tall slender cypress trees punctuating the field, a pale stone farmhouse in the distance, golden late afternoon sun raking across the purple rows, a bee in sharp focus in the foreground, pastoral Provence photography, no text, no watermark"),
    ("18_glacier_lagoon_icebergs", "16:9",
     "Floating blue icebergs in a calm glacier lagoon, chunks of translucent ice glowing turquoise in the cold light, distant snow-covered mountains reflected in the glassy water, tiny ice fragments scattered on the surface, crisp polar landscape photography, ultra detailed, no text, no watermark"),
    ("19_savanna_acacia_sunset", "16:9",
     "A lone flat-topped acacia tree silhouetted on an open African savanna, a herd of giraffes crossing the plain in the distance, enormous orange and violet sunset sky with streaked clouds, dusty golden grass, warm backlit haze, wildlife landscape photography, no text, no watermark"),
    ("20_foggy_pine_forest_aerial", "9:16",
     "Aerial top-down view of dense dark pine forest veiled in low fog, a single pale road cutting a clean line through the canopy, treetops emerging from white mist like islands, muted cold palette, fine art aerial photography, ultra detailed, no text, no watermark"),
    ("21_wheat_field_harvester", "16:9",
     "A combine harvester cutting a golden wheat field at late afternoon, a thick cloud of chaff and dust billowing behind it, long parallel lines of harvested stubble in the foreground, low golden sun flare, warm expansive rural photography, no text, no watermark"),
    ("22_dolomite_dramatic_clouds", "16:9",
     "Pale limestone dolomite peaks rising beneath thick turbulent storm clouds, sharp sunbeams breaking through gaps in the sky, a green alpine meadow in the foreground, tiny wildflowers catching the light, dramatic weather landscape photography, no text, no watermark"),
    ("23_salt_flats_reflection", "16:9",
     "A mirror-thin sheet of water over a vast salt flat, mirroring a towering cumulus sky so perfectly that the horizon disappears, a thin white salt crust cracking in the foreground, distant mountains floating in the reflection, serene minimal landscape photography, no text, no watermark"),
    ("24_bamboo_grove", "9:16",
     "A dense bamboo grove in soft morning fog, tall green culms with golden light filtering through, a narrow packed-earth path curving into the mist, dappled shadow patterns, fresh dew on the leaves, tranquil Japanese nature photography, ultra detailed, no text, no watermark"),
    ("25_tropical_canyon_waterfall", "16:9",
     "A slender white waterfall plunging into a turquoise pool inside a lush tropical canyon, moss-covered cliffs draped with ferns and vines, sunlight shafts cutting through the mist, saturated emerald and jade palette, nature photography, no text, no watermark"),
    ("26_frozen_lake_cracks", "16:9",
     "A frozen lake surface fractured into a web of pale blue cracks, trapped bubbles suspended in the clear ice, low winter sun raking across the frozen plain, distant snow-dusted pines on the horizon, cold delicate blue and white palette, fine art photography, no text, no watermark"),
    ("27_coastal_cliffs_green", "3:4",
     "Tall green sea cliffs plunging into deep blue water, waves exploding white at the base, seabirds wheeling, a grassy clifftop path above, dramatic overcast light with a bright break in the clouds, rugged coastal photography, ultra detailed, no text, no watermark"),
    ("28_hot_spring_terrace", "16:9",
     "Terraced mineral hot springs with vivid orange, rust and turquoise microbial mats, steam drifting across the surface, a lone figure in a towel on the far rim for scale, soft overcast light, geothermal landscape photography, rich color, no text, no watermark"),
    ("29_vineyard_rows_sunset", "16:9",
     "Long parallel rows of vines on rolling hills, ripe purple grapes heavy on the plants, low golden sun flaring between the rows, a distant stone farmhouse and cypress avenue, warm late-harvest landscape photography, ultra detailed, no text, no watermark"),
    ("30_storm_plains_lightning", "16:9",
     "A vast dark storm front sweeping over open plains, a bright forked lightning bolt striking in the distance, rain curtains visible beneath the shelf cloud, golden crop fields in the foreground lit by a shaft of sun, extreme storm photography, no text, no watermark"),
    ("31_brutalist_stairway", "3:4",
     "A monumental brutalist concrete stairway spiraling upward, deep geometric shadows, weathered board-formed concrete texture, a single person in a red coat ascending for scale, overcast diffused light, architectural photography, strong geometry, no text, no watermark"),
    ("32_tokyo_alley_vending_machines", "9:16",
     "A narrow Tokyo back alley at night lined with glowing vending machines, tangled overhead power cables, a bicycle leaning on a wet wall, glowing ramen shop sign, neon reflections in puddles, deep shadows and saturated colour, cyberpunk street photography, no readable text, no watermark"),
    ("33_moroccan_riad_courtyard", "4:3",
     "A Moroccan riad courtyard with zellige tile fountain, intricate carved stucco, potted citrus trees, shafts of sunlight from an unseen roof, a calico cat asleep on the warm stone, rich terracotta and cobalt palette, architectural travel photography, no text, no watermark"),
    ("34_old_library_interior", "16:9",
     "A vast old library interior, two tiers of dark oak galleries and rolling ladders, thousands of leather-bound books, dust motes drifting in a shaft of window light, a green banker's lamp glowing on a reading table, warm sepia atmosphere, ultra detailed, no readable text, no watermark"),
    ("35_modernist_glass_house", "16:9",
     "A modernist glass house at dusk, steel-framed transparent walls glowing warm from within, a lone tree growing through the interior courtyard, reflecting pool in front mirroring the lit structure, crisp architectural photography, no text, no watermark"),
    ("36_subway_station_tiled", "16:9",
     "A vintage tiled subway station platform, cream and oxblood geometric wall tiles, arched vaulted ceiling, warm sodium lamps, a train pulling in with motion blur, empty platform with one bench, cinematic urban photography, rich detail, no readable text, no watermark"),
    ("37_venetian_canal_fog", "9:16",
     "A narrow Venetian canal in heavy morning fog, gondolas half hidden, warm ochre palazzi fading into the mist, water rippling against old stone, a single lit window, romantic muted atmosphere, fine art travel photography, no text, no watermark"),
    ("38_rooftop_greenhouse", "4:3",
     "A rooftop greenhouse above a city at sunrise, glass panes fogged with condensation, lush tomato plants and trailing vines on steel shelving, the city skyline blurred beyond the roof edge, warm golden light, inviting interior photography, no text, no watermark"),
    ("39_industrial_factory_interior", "16:9",
     "The interior of a vast abandoned factory hall, rusted steel gantries and broken floor-to-ceiling windows, shafts of dusty light, weeds growing through cracked concrete, peeling paint, moody desaturated industrial photography, no text, no watermark"),
    ("40_gothic_cathedral_interior", "3:4",
     "The soaring interior of a gothic cathedral, clustered columns rising into vaulted arches, stained glass casting saturated coloured patches on the stone floor, a lone visitor in the distance, reverent volumetric light, architectural photography, no text, no watermark"),
    ("41_neon_arcade", "16:9",
     "An endless retro arcade hall at night, rows of glowing cabinets receding into the distance, pink and blue neon spilling across a polished floor, a person mid-game in silhouette, nostalgic synthwave atmosphere, cinematic, no readable text, no watermark"),
    ("42_mediterranean_white_village", "16:9",
     "A whitewashed Mediterranean hill village, cascading cubic houses with cobalt blue shutters, bougainvillea spilling over walls, a narrow stepped lane, laundry strung between balconies, brilliant midday sun and deep blue sky, travel photography, no text, no watermark"),
    ("43_norwegian_cabin_snow", "16:9",
     "A red timber cabin with a turf roof in a snowy Norwegian forest, smoke curling from the chimney, deep fresh snow with animal tracks, pine trees heavy with frost, warm window light against cold blue twilight, cosy winter photography, no text, no watermark"),
    ("44_art_deco_lobby", "3:4",
     "A 1930s art deco hotel lobby, black and gold marble, polished chrome details, a geometric sunburst mural, a sweeping curved reception desk, a green-shaded lamp, warm tungsten lighting, symmetrical elegant composition, no readable text, no watermark"),
    ("45_street_market_umbrellas", "16:9",
     "A crowded outdoor street market seen from above, a sea of colourful parasols, fruit and flower stalls, narrow lanes between them, a crowd of shoppers, vibrant saturated colour, lively documentary photography, ultra detailed, no text, no watermark"),
    ("46_astronaut_red_planet", "16:9",
     "An astronaut in a white spacesuit walking across rust-red Martian dunes, their own long shadow trailing behind, a dusty horizon under a pale butterscotch sky, rocks scattered in the fine regolith, cinematic science fiction realism, no text, no watermark"),
    ("47_space_station_earth", "16:9",
     "A large orbital space station with solar arrays, gliding above the curve of the blue Earth, the terminator line sweeping across cloud systems, stars and a thin atmospheric glow on the limb, photorealistic space photography, ultra detailed, no text, no watermark"),
    ("48_rover_alien_dunes", "16:9",
     "A six-wheeled exploration rover parked on rippled orange alien sand, its camera mast scanning the horizon, twin tracks trailing behind it, a distant rock formation and two moons in a dim sky, realistic sci-fi concept art, no text, no watermark"),
    ("49_orbital_ring_megastructure", "21:9",
     "A colossal ring megastructure orbiting a planet, its inner surface patterned with city lights, solar collectors casting a long shadow across the planet's atmosphere, stars behind, immense scale, realistic hard science fiction space art, no text, no watermark"),
    ("50_alien_bioluminescent_jungle", "9:16",
     "A dense alien jungle at night, towering fungal columns glowing cyan and violet from within, floating spore lights drifting like fireflies, a narrow stream reflecting the glow, wet black rock, otherworldly bioluminescent atmosphere, no text, no watermark"),
    ("51_lunar_base_dome", "16:9",
     "A pressurised research dome on the Moon's surface, earthlight illuminating its ribbed metal shell, a rover parked at an airlock, the Sea of Tranquility stretching to a razor-sharp horizon, black sky with dense stars, realistic lunar photography, no text, no watermark"),
    ("52_nebula_distant_planet", "16:9",
     "A vast pink and teal nebula filling the sky, dense star fields, a small ringed planet catching light in the lower foreground, dust lanes crossing the gas clouds, deep space astrophotography, ultra detailed, no text, no watermark"),
    ("53_robot_in_rain_city", "3:4",
     "A humanoid robot standing motionless in heavy rain on a city street, water sheeting down its dark metal frame, neon signs reflecting off the wet pavement, a blurred crowd passing, a single umbrella in the foreground, cinematic sci-fi noir, no readable text, no watermark"),
    ("54_cryo_pod_chamber", "16:9",
     "A cryogenic sleep chamber interior, a person lying in a frosted glass pod surrounded by frost, blue diagnostic light strips along the frame, cables and monitoring equipment, vapour pooling at floor level, eerie clinical sci-fi lighting, no text, no watermark"),
    ("55_derelict_starship", "16:9",
     "A vast derelict starship drifting in interstellar space, its hull scorched and broken open, one engine still flickering dimly, debris tumbling nearby, cold blue starlight raking across the metal, abandoned sci-fi atmosphere, ultra detailed, no text, no watermark"),
    ("56_fluid_paint_pour", "1:1",
     "Swirling fluid paint pour of magenta, teal and cream marbling together, glossy wet surface with fine gold veins running through, overhead studio light, high-end digital art, ultra detailed, no text, no watermark"),
    ("57_fractal_geometry", "1:1",
     "Intricate fractal geometry rendered in luminous white lines over a deep indigo field, recursively branching forms with a luminous glow at the centre, mathematically precise, elegant generative artwork, ultra detailed, no text, no watermark"),
    ("58_ink_in_water", "1:1",
     "A plume of black ink blooming and curling through clear water, delicate feathered tendrils against a pale background, macro high-speed capture, soft studio lighting, elegant abstract photography, ultra detailed, no text, no watermark"),
    ("59_woven_textile_pattern", "4:3",
     "A close macro of handwoven textile, indigo and ochre threads in a complex geometric pattern, visible fibre texture and slight irregularities, raking side light revealing the weave, textile design photography, no text, no watermark"),
    ("60_topographic_contour_lines", "1:1",
     "Abstract topographic contour lines on a warm sand-coloured surface, concentric elevation rings forming an organic dune-like pattern, fine crisp linework with subtle paper grain, minimal cartographic design, no text, no watermark"),
    ("61_shattered_glass_refraction", "1:1",
     "A radial shatter of thick glass, each fracture catching and splitting light into prismatic colour, sharp crystalline edges, dark background, macro high-speed photography, ultra detailed, no text, no watermark"),
    ("62_liquid_chrome_blob", "1:1",
     "A mirror-polished liquid chrome blob floating in a soft grey studio void, warping its surroundings across a smooth reflective surface, subtle blue and amber highlights, hyperrealistic 3D render, ultra detailed, no text, no watermark"),
    ("63_translucent_circles", "1:1",
     "Overlapping translucent circles of coral, teal and amber layered on a warm cream background, soft multiply blending creating new hues at the intersections, clean flat geometry with subtle paper texture, minimal design artwork, no text, no watermark"),
    ("64_marbled_paper", "3:4",
     "Traditional marbled paper with swirling feathered veins of slate blue, rust and cream, fine comb-drawn tendrils, a soft raking light revealing the paper's surface, elegant craft photography, ultra detailed, no text, no watermark"),
    ("65_gradient_mesh_sunset", "16:9",
     "A smooth gradient mesh blending deep violet into coral, amber and soft teal, with no visible edges between the colour fields, luminous and atmospheric, modern abstract digital artwork, ultra detailed, no text, no watermark"),
    ("66_elderly_fisherman_portrait", "3:4",
     "A weathered elderly fisherman in a faded blue knit jumper, deeply lined face lit by soft window light from the side, a knitted cap on his head, harbour water and moored boats blurred behind, intimate environmental portrait, 85mm, no text, no watermark"),
    ("67_samurai_in_snow", "9:16",
     "A lone samurai in dark layered armour and a horned helmet standing in falling snow, breath visible in the cold air, a weathered stone lantern beside him, muted blue-grey palette with one warm lantern glow, cinematic portrait, no text, no watermark"),
    ("68_ballerina_mid_leap", "4:3",
     "A ballerina caught at the peak of a leap, tutu blurred with the motion, pointe shoes extended, arms in a wide open port de bras, a dim stage with a single warm spotlight, dust motes in the beam, dramatic dance photography, no text, no watermark"),
    ("69_beekeeper", "3:4",
     "A beekeeper in a white veiled suit and heavy gloves lifting a honeycomb frame from an open hive, bees circling in golden afternoon light, honeycomb cells glistening, warm earthy documentary portrait, no text, no watermark"),
    ("70_jazz_saxophonist", "4:3",
     "A jazz saxophonist playing in a dim smoky club, brass instrument catching a warm spotlight, sweat on his face, deep red curtain behind, out-of-focus bandstand lights, intimate music portrait, rich contrast, no text, no watermark"),
    ("71_desert_nomad", "16:9",
     "A desert nomad in layered indigo robes leading a laden camel across pale dunes at dawn, long shadow behind, wind lifting the fabric, vast empty sky, muted sand and blue palette, documentary travel photography, no text, no watermark"),
    ("72_blacksmith_sparks", "3:4",
     "A blacksmith swinging a hammer onto glowing orange steel, a burst of white sparks flying, the firebox glowing behind, soot and rough leather apron, dark workshop lit only by the hot metal, dramatic industrial photography, no text, no watermark"),
    ("73_violinist_street", "16:9",
     "A street violinist playing on a sunlit European pavement, music sheet clipped to the instrument, a small open case for coins, warm afternoon light and long shadows on the cobblestones, candid documentary photography, no readable text, no watermark"),
    ("74_diver_underwater", "3:4",
     "A scuba diver in a black wetsuit hovering in clear blue water, silver bubbles rising, sunlight shafts descending from the surface, a school of small fish scattered in the distance, serene underwater portrait, ultra detailed, no text, no watermark"),
    ("75_child_with_kite", "16:9",
     "A child running across a wide grassy field flying a bright red kite, the kite high in a deep blue sky with swirling white clouds, long grass bending in the wind, warm backlit afternoon light, nostalgic outdoor photography, no text, no watermark"),
    ("76_frost_crystals_glass", "1:1",
     "Delicate frost fern crystals spreading across a window pane, intricate ice dendrites catching pale blue winter light, the cold glass blurring the street beyond, macro photography, razor-sharp detail, no text, no watermark"),
    ("77_coffee_crema", "1:1",
     "A fresh espresso in a white ceramic cup seen from directly above, dense golden crema swirling on the surface, a few bubbles and a swirl of milk, saucer and a scattering of coffee beans, warm soft light, food photography, no text, no watermark"),
    ("78_butterfly_wing_scales", "1:1",
     "Extreme macro of a butterfly wing, thousands of overlapping scales catching iridescent blue and orange light, a single vein running through, incredibly fine texture, shallow depth of field, nature macro photography, no text, no watermark"),
    ("79_rusted_key", "1:1",
     "An old iron key lying on weathered grey wood, heavy orange rust pitting the surface, chipped brass bow, a single drop of water beading on the shaft, soft directional light, still-life macro photography, no text, no watermark"),
    ("80_raindrop_on_leaf", "1:1",
     "A single clear raindrop resting on a broad green leaf, the droplet acting as a lens showing an inverted miniature of the surrounding foliage, veins in the leaf sharply detailed, soft diffused overcast light, macro nature photography, no text, no watermark"),
    ("81_eye_macro_iris", "1:1",
     "An extreme macro of a human eye, the iris ringed with intricate amber and olive fibres, fine eyelashes catching light, a soft window reflection in the moist surface, tack-sharp focus, portrait macro photography, no text, no watermark"),
    ("82_salt_crystals", "1:1",
     "Halite salt crystals clustered on a dark stone, translucent cubes with sharp edges refracting a faint rainbow, coarse ground salt scattered around, raking low light, mineral macro photography, ultra detailed, no text, no watermark"),
    ("83_fabric_threads", "1:1",
     "Extreme macro of coarse woven linen, individual threads and their natural slubs in sharp relief, warm undyed cream fibres, a single stray red thread crossing the frame, raking light revealing texture, textile photography, no text, no watermark"),
    ("84_soap_bubble", "1:1",
     "A single soap bubble floating against a dark background, swirling iridescent rainbow film across its surface, a window reflection curved on the skin, razor-sharp detail on the delicate membrane, studio lighting, macro photography, no text, no watermark"),
    ("85_cracked_paint_texture", "1:1",
     "A close macro of old painted plaster, a network of fine cracks and flaking layers revealing red oxide primer beneath grey and white, a small chip exposing the brick below, raking afternoon light, abstract texture photography, no text, no watermark"),
    ("86_ramen_bowl_top_view", "1:1",
     "A bowl of ramen seen from directly above, soft-boiled egg halved with a jammy orange yolk, pork chashu, scallions, nori and a swirl of noodles in clear golden broth, chopsticks resting on the rim, warm overhead light, food photography, no text, no watermark"),
    ("87_bread_and_butter", "4:3",
     "A torn-open rustic sourdough loaf with a steamy open crumb, a knob of salted butter melting on a board, toasted seeds and a dusting of flour, a linen napkin and a bread knife, warm morning window light, food photography, no text, no watermark"),
    ("88_citrus_sliced_macro", "1:1",
     "Slices of blood orange and grapefruit fanned across a marble surface, glistening juice droplets, a halved fruit showing deep ruby flesh, a small knife and stray pulp, bright natural light, vivid food macro photography, no text, no watermark"),
    ("89_chocolate_mousse", "3:4",
     "A glass of glossy dark chocolate mousse, a quenelle of whipped cream on top, a curl of chocolate shavings, cocoa powder dusted on the surface, moody dark background with a single soft key light, luxury dessert photography, no text, no watermark"),
    ("90_seafood_platter", "16:9",
     "An ice-filled seafood platter seen from above, oysters on the half shell, prawns, mussels, crab claws and lemon wedges, crushed ice glistening, slate and linen textures, fresh cool lighting, food photography, no text, no watermark"),
    ("91_snow_leopard", "3:4",
     "A snow leopard crouched on a rocky mountainside, thick spotted grey-white fur heavy with snow, pale green eyes fixed forward, a long tail draped over the stone, cold high-altitude light, wildlife photography, ultra detailed, no text, no watermark"),
    ("92_owl_in_flight", "16:9",
     "A barn owl in full flight, wings spread wide with every primary feather separated, white underside catching low sunlight, a mouse in its talons, blurred field and hedgerow behind, fine art wildlife photography, no text, no watermark"),
    ("93_whales_underwater", "16:9",
     "A pod of humpback whales swimming underwater in clear blue ocean, sunlight beams descending from the surface, spray and bubbles, one whale raising its fluke, vast open water around them, cinematic marine wildlife photography, no text, no watermark"),
    ("94_red_fox_in_snow", "3:4",
     "A red fox standing alert in deep snow, thick winter coat and black legs, breath hanging in the frozen air, frost-coated birch trees behind, soft blue twilight with warm fur tones, wildlife photography, ultra detailed, no text, no watermark"),
    ("95_hummingbird", "1:1",
     "A hummingbird hovering at a red trumpet flower, wings frozen in a blur of motion, iridescent emerald and magenta throat feathers, a long beak entering the flower, soft green garden background, high-speed wildlife photography, no text, no watermark"),
    ("96_elephant_dust", "16:9",
     "An African elephant walking through dry scrub at golden hour, a thick cloud of dust hanging in the backlit air, long shadow stretching toward the camera, warm ochre grass, wildlife photography, ultra detailed, no text, no watermark"),
    ("97_jellyfish", "9:16",
     "A translucent jellyfish drifting through dark blue water, long trailing tentacles catching a shaft of light, faint internal structure visible in its bell, drifting particles around it, serene underwater photography, ultra detailed, no text, no watermark"),
    ("98_wolf_howling", "16:9",
     "A grey wolf howling on a rocky ridge at dusk, head raised, breath visible in the cold air, snow-dusted boulders, a dark valley fading into mist below, muted blue-grey palette, wildlife photography, ultra detailed, no text, no watermark"),
    ("99_koi_pond", "4:3",
     "Orange and white koi fish gliding in a dark garden pond, rippling water distorting their markings, scattered lily pads, a few soft petals floating, dappled shade from an overhanging maple, tranquil Japanese garden photography, no text, no watermark"),
    ("100_sea_turtle_reef", "16:9",
     "A green sea turtle swimming over a sunlit coral reef, flippers mid-stroke, schools of small silver fish streaming past, clear turquoise water with light caustics, vibrant coral in coral and pink, marine wildlife photography, no text, no watermark"),
    ("101_mosque_tiled_dome", "3:4",
     "The interior of a vast Ottoman mosque, an enormous central dome covered in intricate turquoise and lapis Iznik tiles, a ring of arched windows below it, rows of slender columns, a single low pendant lamp, shafts of warm light entering the windows, reverent architectural photography, ultra detailed, no text, no watermark"),
    ("102_torii_gate_mist", "9:16",
     "A corridor of vermilion torii gates climbing a forested hillside, the nearest gate large in frame and the rest receding into pale morning mist, mossy stone and ferns at the base, soft diffused light, tranquil Japanese travel photography, no text, no watermark"),
    ("103_clownfish_anemone", "1:1",
     "A single orange clownfish nestled in the waving purple tentacles of a sea anemone, fine filament detail across the fish, warm reef light filtering down from the surface, teal water fading to blue behind, underwater macro wildlife photography, ultra detailed, no text, no watermark"),
    ("104_vintage_motorcycle_barn", "4:3",
     "A vintage 1950s motorcycle parked in a sunlit wooden barn, dusty chrome and deep green paint, shafts of warm light streaming through gaps in the barn doors, hay bales and hanging tools, nostalgic documentary photography, rich contrast, no text, no watermark"),
    ("105_reading_nook_rain", "3:4",
     "A cosy reading nook beside a window streaked with rain, a worn armchair with a knitted throw, a stack of books and a steaming mug on a side table, a warm table lamp glowing, blurred wet garden beyond, intimate interior photography, no readable text, no watermark"),
    ("106_roman_aqueduct_valley", "16:9",
     "An ancient Roman aqueduct of tall weathered arches stretching across a dry golden valley, hazy hills behind, a shepherd and flock small at its base, low afternoon sun raking across the stone, sweeping landscape photography, ultra detailed, no text, no watermark"),
    ("107_sunflowers_storm_sky", "21:9",
     "A vast field of tall sunflowers turning toward a vast storm front, heavy charcoal clouds breaking to reveal a shaft of golden light on the horizon, the sunflowers dark and silhouetted in the foreground, wild wind in the stalks, dramatic weather landscape, no text, no watermark"),
    ("108_macaron_tower", "1:1",
     "A tall tower of pastel macarons in pink, pistachio, lemon and lilac, stacked on a marble cake stand, delicate ruffled shells with visible feet, soft bakery light, minimal patisserie food photography, shallow depth of field, no text, no watermark"),
    ("109_cyclist_misty_forest_road", "16:9",
     "A lone cyclist riding away down a misty pine forest road at dawn, breath visible in the cold air, headlight glowing softly, tall trees closing in on both sides, wet asphalt reflecting the dim light, atmospheric cycling photography, no text, no watermark"),
    ("110_observatory_telescope", "16:9",
     "A vintage brass refracting telescope beneath the open slit of a domed observatory ceiling, the night sky and a scatter of stars visible through the opening, dark wood floor, a single warm lamp casting long shadows, rich detail, atmospheric night photography, no text, no watermark"),
]


def build_args(items):
    return {
        "requests": [
            {
                "prompt": prompt,
                "aspect_ratio": ratio,
                "resolution": "2K",
                "output_file": stem,
            }
            for stem, ratio, prompt in items
        ]
    }


def run(cmd, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def main():
    os.makedirs(DEST, exist_ok=True)
    os.makedirs(REC_DIR, exist_ok=True)
    assert len(ITEMS) == 100, f"expected 100 items, got {len(ITEMS)}"
    stems = [i[0] for i in ITEMS]
    assert len(set(stems)) == 100, "duplicate filename stems"

    manifest = {"items": [], "generated": [], "downloaded": [], "failed": []}
    man_path = os.path.join(REC_DIR, "batch100_manifest.json")

    batches = [ITEMS[i:i + BATCH_SIZE] for i in range(0, len(ITEMS), BATCH_SIZE)]
    for bi, batch in enumerate(batches, start=1):
        args_path = os.path.join(REC_DIR, f"batch100_args_{bi}.json")
        with open(args_path, "w", encoding="utf-8") as fh:
            json.dump(build_args(batch), fh, ensure_ascii=False, indent=2)
        print(f"=== BATCH {bi}/{len(batches)} :: items {batch[0][0]} .. {batch[-1][0]} ===", flush=True)
        proc = run([
            "mcode-tools", "connector", "call",
            "connector__matrix__generate_image",
            "--args-file", args_path,
        ])
        raw_path = os.path.join(REC_DIR, f"batch100_gen_{bi}.json")
        with open(raw_path, "w", encoding="utf-8") as fh:
            fh.write(proc.stdout)
        if proc.returncode != 0:
            print(f"batch {bi} FAILED exit={proc.returncode}: {proc.stderr[:600]}", flush=True)
            manifest["failed"].append({"batch": bi, "reason": proc.stderr[:600]})
            with open(man_path, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2)
            continue
        try:
            data = json.loads(proc.stdout)
        except Exception as exc:
            print(f"batch {bi} unparseable: {exc}", flush=True)
            manifest["failed"].append({"batch": bi, "reason": f"unparseable {exc}"})
            continue
        ok = data.get("success_items", [])
        bad = data.get("failed_items", [])
        print(f"batch {bi}: {len(ok)} ok, {len(bad)} failed", flush=True)
        for item in ok:
            manifest["generated"].append(item)
        for item in bad:
            manifest["failed"].append({"batch": bi, "item": item})
        with open(man_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2)

    print(f"TOTAL generated={len(manifest['generated'])} failed={len(manifest['failed'])}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
