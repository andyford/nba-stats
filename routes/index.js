var express = require('express');
var router = express.Router();
var _ = require('underscore');
var CONFIG = require('../config.js');
var zlib = require('zlib');

router.get('/', function(req, res, next) {
  var fs = require('fs');
  var dateNow = Date.now();
  var colorScale = {
    // inspired by http://colorbrewer2.org/
    hi: [67, 147, 195], // blue
    mid: [255, 255, 205], // yellow
    low: [214, 96, 77] // red
  };
  var teamStats;

  var standingsData = initDataSource({
    filename: 'standings',
    dateField: 'standings_date'
  });
  var teamStatsData = initDataSource({
    filename: 'team-stats',
    dateField: 'team_stats_date'
  });

  getDataSource(teamStatsData, processTeamStats);

  function initDataSource (opts) {
    var obj = {
      dateField: opts.dateField,
      maxCacheAgeInHours: (opts.maxCache || .001),
      urlLocal: 'public/data/' + opts.filename + '.json',
      urlRemote: 'nba/' + opts.filename + '.json',
    };
    obj.cachedStr = fs.readFileSync(obj.urlLocal, 'utf8');
    obj.cachedObj = JSON.parse(obj.cachedStr);
    return obj;
  }

  // callback = updateCacheAndRenderResult
  function getDataSource (src, callback) {
    // if json does not include 'nbaAppLastCheck', then compare against 'dateField' provided by API
    // NOTE: some endpoints provide date only (no timestamp)
    var lastCacheCheckDate = src.cachedObj.nbaAppLastCheck || src.cachedObj[src.dateField];
    var hoursSinceLastCheck = (dateNow - Date.parse(new Date(lastCacheCheckDate))) / (1000 * 60 * 60);
    console.log('hoursSinceLastCheck ' + hoursSinceLastCheck + ' ===============================');

    // get data from remote source if local cache is over 'maxCacheAgeInHours' old
    if (hoursSinceLastCheck > src.maxCacheAgeInHours) {
      console.log('get from remote source');
      getRemoteResource(src, callback);
    } else {
      console.log('get from local cache');
      callback(src);
    }
  }

  function processTeamStats (src, data) {
    console.log('process team stats...');
    data = data || src.cachedStr;
    teamStats = JSON.parse(data);
    updateCache(src, data);
    getDataSource(standingsData, updateCacheAndRenderResult);
  }

  function getRemoteResource (src, callback) {
    console.log('getRemoteResource ++++++++++++++++++++++++++++++++++++++++++++++++++++');
    var https = require('https');
    var options = {
      'host': CONFIG.API_HOST,
      'path': CONFIG.API_URL + src.urlRemote,
      'headers': {
        'Accept-Encoding': 'gzip',
        'Authorization': 'Bearer ' + CONFIG.API_TOKEN,
        'User-Agent': CONFIG.USER_AGENT
      }
    };

    https.get(options, function (res) {
      var chunks = [];

      res.on('data', function (chunk) { chunks.push(chunk); });

      res.on('end', function () {
        if (res.statusCode !== 200 && res.statusCode !== 304) {
          console.warn("Server did not return a 200 or 304 response!\n" + chunks.join(''));
          callback(src);
          return;
        }

        if (encoding = res.headers['content-encoding'] === 'gzip') {
          zlib.gunzip(Buffer.concat(chunks), function (err, decoded) {
            if (err) {
              console.warn("Error trying to decompress data: " + err.message);
              callback(src);
              return;
            }
            callback(src, decoded);
          });
        } else {
          callback(src, chunks.join(''));
        }
      });
    }).on('error', function (err) {
      console.warn("Error trying to contact server: " + err.message);
      callback(src);
      return;
    });
  }

  function processResult (data) {
    data = JSON.parse(data);

    var didStartWest = false;

    // add stats to each team
    // lots of stats: https://www.teamrankings.com/nba/stat/opponent-shooting-pct
    _.each(data.standing, function (el, idx) {

      if (el.conference === 'WEST' && !didStartWest) {
        el.first_west = true;
        didStartWest = true;
      }

      // add team & opponent stats
      var stats = _.find(teamStats.team_stats, function (it) {
        return it.team.team_id === el.team_id;
      });
      el.team_stats = stats.stats;
      el.opponent_stats = stats.stats_opponent;

      // possessions estimate - not an exact science
      el.possessions = (el.team_stats.field_goals_attempted + el.team_stats.turnovers - el.team_stats.offensive_rebounds) + (el.team_stats.free_throws_attempted * 0.44);
      el.team_stats.possessions_per_game = el.possessions / el.games_played;

      el.opponent_possessions = (el.opponent_stats.field_goals_attempted + el.opponent_stats.turnovers - el.opponent_stats.offensive_rebounds) + (el.opponent_stats.free_throws_attempted * 0.44);
      el.opponent_stats.possessions_per_game = el.opponent_possessions / el.games_played;

      el.team_stats.assist_to_turnover_ratio = el.team_stats.assists / el.team_stats.turnovers;

      // eFG% = (FGM + (0.5 x 3PTM)) / FGA
      el.team_stats.effective_field_goal_percentage = (el.team_stats.field_goals_made + (0.5 * el.team_stats.three_point_field_goals_made)) / el.team_stats.field_goals_attempted;

      // 2pt fg%
      el.team_stats.two_point_field_goal_percentage = (el.team_stats.field_goals_made - el.team_stats.three_point_field_goals_made) / (el.team_stats.field_goals_attempted - el.team_stats.three_point_field_goals_attempted);

      // true shooting pct = PTS / (2 * (FGA + (0.44 * FTA)))
      el.team_stats.true_shooting_percentage = el.team_stats.points / (2 * (el.team_stats.field_goals_attempted + (el.team_stats.free_throws_attempted * 0.44)));

      // free throw rates
      el.team_stats.free_throws_attempted_per_pos = el.team_stats.free_throws_attempted / el.possessions;
      el.team_stats.free_throws_made_per_pos = el.team_stats.free_throws_made / el.possessions;

      el.team_stats.points_per_pos = el.points_for / el.possessions; // offensive efficiency
      el.team_stats.assists_per_pos = el.team_stats.assists / el.possessions;
      el.team_stats.field_goals_attempted_per_pos = el.team_stats.field_goals_attempted / el.possessions;
      el.team_stats.turnovers_per_pos = el.team_stats.turnovers / el.possessions;

      el.opponent_stats.turnovers_per_pos = el.opponent_stats.turnovers / el.opponent_possessions;

      el.opponent_stats.points_per_pos = el.points_against / el.opponent_possessions; // defensive efficiency

      el.team_stats.assists_per_fg = el.team_stats.assists / el.team_stats.field_goals_made;

      el.team_stats.rebound_percentage = el.team_stats.rebounds / (el.team_stats.rebounds + el.opponent_stats.rebounds);
      el.team_stats.defensive_rebound_percentage = el.team_stats.defensive_rebounds / (el.team_stats.defensive_rebounds + el.opponent_stats.offensive_rebounds);
      el.team_stats.offensive_rebound_percentage = el.team_stats.offensive_rebounds / (el.team_stats.offensive_rebounds + el.opponent_stats.defensive_rebounds);

      el.team_stats.blocks_per_opp_possession = el.team_stats.blocks / el.opponent_possessions;
      el.team_stats.steals_per_opp_possession = el.team_stats.steals / el.opponent_possessions;

      el.team_stats.personal_foul_percentage = el.team_stats.personal_fouls / el.opponent_possessions;

      el.opponent_stats.personal_foul_percentage = el.opponent_stats.personal_fouls / el.possessions;
      el.opponent_stats.field_goals_attempted_per_pos = el.opponent_stats.field_goals_attempted / el.opponent_possessions;
    });

    var ppg = calcTeamStat(data.standing, 'points_per_game_string');
    var pointsPP = calcTeamStat(data.standing, 'points_per_pos');
    var posPG = calcTeamStat(data.standing, 'possessions_per_game');
    var oppPosPG = calcTeamStat(data.standing, 'possessions_per_game', true);

    var oppPointsPP = calcTeamStat(data.standing, 'points_per_pos', true);

    var apg = calcTeamStat(data.standing, 'assists_per_game_string');
    var assistsPP = calcTeamStat(data.standing, 'assists_per_pos');
    var assistsFG = calcTeamStat(data.standing, 'assists_per_fg');

    var rpg = calcTeamStat(data.standing, 'rebounds_per_game_string');
    var rebPct = calcTeamStat(data.standing, 'rebound_percentage');
    var oRebPct = calcTeamStat(data.standing, 'offensive_rebound_percentage');
    var dRebPct = calcTeamStat(data.standing, 'defensive_rebound_percentage');
    var orpg = calcTeamStat(data.standing, 'offensive_rebounds_per_game_string');
    var drpg = calcTeamStat(data.standing, 'defensive_rebounds_per_game_string');

    var bpg = calcTeamStat(data.standing, 'blocks_per_game_string');
    var blocksPP = calcTeamStat(data.standing, 'blocks_per_opp_possession');

    var spg = calcTeamStat(data.standing, 'steals_per_game_string');
    var stealsPP = calcTeamStat(data.standing, 'steals_per_opp_possession');

    var topg = calcTeamStat(data.standing, 'turnovers_per_game_string');
    var toPP = calcTeamStat(data.standing, 'turnovers_per_pos');
    var otopg = calcTeamStat(data.standing, 'turnovers_per_game_string', true);
    var otoPP = calcTeamStat(data.standing, 'turnovers_per_pos', true);

    var atoRatio = calcTeamStat(data.standing, 'assist_to_turnover_ratio');

    var fgapg = calcTeamStat(data.standing, 'field_goals_attempted_per_game_string');
    var fgmpg = calcTeamStat(data.standing, 'field_goals_made_per_game_string');
    var fgPct = calcTeamStat(data.standing, 'field_goal_percentage_string');
    var efgPct = calcTeamStat(data.standing, 'effective_field_goal_percentage');
    var tsPct = calcTeamStat(data.standing, 'true_shooting_percentage');

    var fgaPP = calcTeamStat(data.standing, 'field_goals_attempted_per_pos');

    var fg2Pct = calcTeamStat(data.standing, 'two_point_field_goal_percentage');

    var fg3apg = calcTeamStat(data.standing, 'three_point_field_goals_attempted_per_game_string');
    var fg3mpg = calcTeamStat(data.standing, 'three_point_field_goals_made_per_game_string');
    var fg3Pct = calcTeamStat(data.standing, 'three_point_field_goal_percentage_string');

    var ftapg = calcTeamStat(data.standing, 'free_throws_attempted_per_game_string');
    var ftmpg = calcTeamStat(data.standing, 'free_throws_made_per_game_string');
    var ftPct = calcTeamStat(data.standing, 'free_throw_percentage_string');
    var ftaPP = calcTeamStat(data.standing, 'free_throws_attempted_per_pos');
    var ftmPP = calcTeamStat(data.standing, 'free_throws_made_per_pos');

    var pfpg = calcTeamStat(data.standing, 'personal_fouls_per_game_string');
    var pfPP = calcTeamStat(data.standing, 'personal_foul_percentage');

    var opp = {
      fg: {
        pct: calcTeamStat(data.standing, 'field_goal_percentage_string', true),
        pp: calcTeamStat(data.standing, 'field_goals_attempted_per_pos', true)
      },
      pf: {
        pg: calcTeamStat(data.standing, 'personal_fouls_per_game_string', true),
        pp: calcTeamStat(data.standing, 'personal_foul_percentage', true)
      }
    };


    // point differential min/max
    var pointDiffMax = _.max(data.standing, function (it) {
      return toNum(it.point_differential_per_game);
    }).point_differential_per_game;

    var pointDiffMin = _.min(data.standing, function (it) {
      return toNum(it.point_differential_per_game);
    }).point_differential_per_game;

    // win/loss streak
    function streakLeader (it) {
      return it.streak_total;
    }

    var teamsOnWinningStreak = _.filter(data.standing, function (it) {
      return it.streak_type === 'win';
    });
    var teamsOnLosingStreak = _.filter(data.standing, function (it) {
      return it.streak_type === 'loss';
    });

    var streakMax = _.max(teamsOnWinningStreak, streakLeader).streak_total;
    var streakMin = _.max(teamsOnLosingStreak, streakLeader).streak_total * -1;


    // operate on each team...
    _.each(data.standing, function (el, idx) {
      var last5num = el.last_five.split('-');
      var last5pct = toNum(last5num[0]) / (toNum(last5num[0]) + toNum(last5num[1]));
      var last10num = el.last_ten.split('-');
      var last10pct = toNum(last10num[0]) / (toNum(last10num[0]) + toNum(last10num[1]));
      var pointDiff = toNum(el.point_differential_per_game);
      var pointDiffRatio = 0;
      var streakRatio = 0;

      if (pointDiff > 0) {
        pointDiffRatio = pointDiff / pointDiffMax;
      } else if (pointDiff < 0) {
        pointDiffRatio = pointDiff / pointDiffMin;
      }

      if (el.streak_type ==='win') {
        streak = toNum(el.streak_total);
        streakRatio = el.streak_total / streakMax;
      } else {
        streak = -1 * toNum(el.streak_total);
        streakRatio = -1 * el.streak_total / streakMin;
      }

      el.colors = {
        assist_to_turnover_ratio: calcColorsFromRange(el.team_stats.assist_to_turnover_ratio, atoRatio),
        assists_per_fg: calcColorsFromRange(el.team_stats.assists_per_fg, assistsFG),
        assists_per_game: calcColorsFromRange(el.team_stats.assists_per_game_string, apg),
        assists_per_pos: calcColorsFromRange(el.team_stats.assists_per_pos, assistsPP),
        blocks_per_game: calcColorsFromRange(toNum(el.team_stats.blocks_per_game_string), bpg),
        blocks_per_opp_possession: calcColorsFromRange(el.team_stats.blocks_per_opp_possession, blocksPP),
        defensive_rebound_percentage: calcColorsFromRange(el.team_stats.defensive_rebound_percentage, dRebPct),
        defensive_rebounds_per_game: calcColorsFromRange(toNum(el.team_stats.defensive_rebounds_per_game_string), drpg),
        efg_pct: calcColorsFromRange(el.team_stats.effective_field_goal_percentage, efgPct),
        fg2_pct: calcColorsFromRange(el.team_stats.two_point_field_goal_percentage, fg2Pct),
        fg3_pct: calcColorsFromRange(toNum(el.team_stats.three_point_field_goal_percentage_string), fg3Pct),
        fg3a_per_game: calcColorsFromRange(toNum(el.team_stats.three_point_field_goals_attempted_per_game_string), fg3apg),
        fg3m_per_game: calcColorsFromRange(toNum(el.team_stats.three_point_field_goals_made_per_game_string), fg3mpg),
        fg_pct: calcColorsFromRange(toNum(el.team_stats.field_goal_percentage_string), fgPct),
        fga_per_game: calcColorsFromRange(toNum(el.team_stats.field_goals_attempted_per_game_string), fgapg),
        fga_per_pos: calcColorsFromRange(el.team_stats.field_goals_attempted_per_pos, fgaPP),
        fgm_per_game: calcColorsFromRange(toNum(el.team_stats.field_goals_made_per_game_string), fgmpg),
        ft_pct: calcColorsFromRange(toNum(el.team_stats.free_throw_percentage_string), ftPct),
        fta_per_game: calcColorsFromRange(toNum(el.team_stats.free_throws_attempted_per_game_string), ftapg),
        fta_per_pos: calcColorsFromRange(el.team_stats.free_throws_attempted_per_pos, ftaPP),
        ftm_per_game: calcColorsFromRange(toNum(el.team_stats.free_throws_made_per_game_string), ftmpg),
        ftm_per_pos: calcColorsFromRange(el.team_stats.free_throws_made_per_pos, ftmPP),
        offensive_rebound_percentage: calcColorsFromRange(el.team_stats.offensive_rebound_percentage, oRebPct),
        offensive_rebounds_per_game: calcColorsFromRange(toNum(el.team_stats.offensive_rebounds_per_game_string), orpg),
        personal_foul_percentage: calcColorsFromRange(el.team_stats.personal_foul_percentage, pfPP, 'low'),
        personal_fouls_per_game: calcColorsFromRange(toNum(el.team_stats.personal_fouls_per_game_string), pfpg, 'low'),
        points_per_game: calcColorsFromRange(toNum(el.team_stats.points_per_game_string), ppg),
        points_per_pos: calcColorsFromRange(el.team_stats.points_per_pos, pointsPP),
        possessions_per_game: calcColorsFromRange(el.team_stats.possessions_per_game, posPG),
        rebound_percentage: calcColorsFromRange(el.team_stats.rebound_percentage, rebPct),
        rebounds_per_game: calcColorsFromRange(toNum(el.team_stats.rebounds_per_game_string), rpg),
        steals_per_game: calcColorsFromRange(toNum(el.team_stats.steals_per_game_string), spg),
        steals_per_opp_possession: calcColorsFromRange(el.team_stats.steals_per_opp_possession, stealsPP),
        ts_pct: calcColorsFromRange(el.team_stats.true_shooting_percentage, tsPct),
        turnovers_per_game: calcColorsFromRange(toNum(el.team_stats.turnovers_per_game_string), topg, 'low'),
        turnovers_per_pos: calcColorsFromRange(el.team_stats.turnovers_per_pos, toPP, 'low'),

        away_win_percentage: calcColorsFromPercent(winPct(el.away_won, el.away_lost)),
        conf_win_percentage: calcColorsFromPercent(winPct(el.conference_won, el.conference_lost)),
        home_win_percentage: calcColorsFromPercent(winPct(el.home_won, el.home_lost)),
        last_five: calcColorsFromPercent(last5pct),
        last_ten: calcColorsFromPercent(last10pct),
        point_diff: calcColorsFromSpread(pointDiff, pointDiffRatio),
        streak_total: calcColorsFromSpread(streak, streakRatio),
        win_percentage: calcColorsFromPercent(el.win_percentage),

        opp: {
          fg_pct: calcColorsFromRange(toNum(el.opponent_stats.field_goal_percentage_string), opp.fg.pct, 'low'),
          fg_pp: calcColorsFromRange(el.opponent_stats.field_goals_attempted_per_pos, opp.fg.pp, 'low'),
          personal_foul_percentage: calcColorsFromRange(el.opponent_stats.personal_foul_percentage, opp.pf.pp),
          personal_fouls_per_game: calcColorsFromRange(toNum(el.opponent_stats.personal_fouls_per_game_string), opp.pf.pg),
          points_per_pos: calcColorsFromRange(el.opponent_stats.points_per_pos, oppPointsPP, 'low'),
          possessions_per_game: calcColorsFromRange(el.opponent_stats.possessions_per_game, oppPosPG),
          turnovers_per_game: calcColorsFromRange(toNum(el.opponent_stats.turnovers_per_game_string), otopg),
          turnovers_per_pos: calcColorsFromRange(el.opponent_stats.turnovers_per_pos, otoPP),
        }
      };

      var isDebug = (el.team_id === 'golden-state-warriors'); // golden-state-warriors
      if (isDebug) {
        console.log(el);
      }
    });

    return data;
  }

  function winPct (w, l) {
    return  w / (w + l);
  }

  function toNum (n) {
    return parseFloat(n, 10);
  }

  function numSort (arr) {
    return arr.sort(function (a, b) { return a - b; });
  }

  function calcTeamStat (data, stat, isOpponent) {
    var team = isOpponent ? 'opponent_stats' : 'team_stats';

    var max = _.max(data, function (it) {
      return toNum(it[team][stat]);
    })[team][stat];

    var min = _.min(data, function (it) {
      return toNum(it[team][stat]);
    })[team][stat];

    var vals = _.map(data, function (it) {
      return toNum(it[team][stat]);
    });

    return {
      min: min,
      max: max,
      median: getMedian(vals)
    };
  }

  function getMedian (arr) {
    // thanks: https://github.com/angusgibbs/statsjs/blob/master/lib/stats.js
    var len = arr.length;
    arr = numSort(arr);

    if (len % 2 === 0) {
      // Even number of elements. Median is the average of the middle two
      return (arr[(len / 2) - 1] + arr[len / 2]) / 2;
    } else {
      // Odd number of elements. Median is the middle one
      return arr[(len - 1) / 2];
    }
  }

  // c1 = color1, c2 = color2, pct1 = % of color1 to use
  function colorBlend (c1, c2, pct1) {
    // TODO: input validation
    pct1 = pct1 * 100;
    var pct2 = 100 - pct1;
    return [
      Math.floor(((c1[0] * pct1) + (c2[0] * pct2)) / 100),
      Math.floor(((c1[1] * pct1) + (c2[1] * pct2)) / 100),
      Math.floor(((c1[2] * pct1) + (c2[2] * pct2)) / 100)
    ];
  }

  // arg stat = num
  // arg population = {min, max, medium}
  // arg positive = ['high' || 'low'] (will high or low numbers be treated as positive (blue)?)
  function calcColorsFromRange (stat, population, positive) {
    var rgb;
    var spectrum;
    var place;

    positive = positive || 'high';

    if (stat === population.max) {
      rgb = colorScale[positive === 'high' ? 'hi' : 'low'].join();
    } else if (stat === population.min) {
      rgb = colorScale[positive === 'high' ? 'low' : 'hi'].join();
    } else if (stat === population.median) {
      rgb = colorScale.mid.join();
    } else if (stat > population.median) {
      spectrum = (population.max - population.median);
      place = (population.max - stat);
      rgb = colorBlend(colorScale[positive === 'high' ? 'hi' : 'low'], colorScale.mid, (1 - (place / spectrum))).join();
    } else {
      spectrum = (population.median - population.min);
      place = (population.median - stat);
      rgb = colorBlend(colorScale.mid, colorScale[positive === 'high' ? 'low' : 'hi'], (1 - (place / spectrum))).join();
    }
    return rgb;
  }

  // arg stat = number 0 through 1
  function calcColorsFromPercent (stat) {
    var rgb;
    if (stat > 0.5) {
      rgb = colorBlend(colorScale.hi, colorScale.mid, ((stat - .5) * 2)).join();
    } else if (stat === 0.5) {
      rgb = colorScale.mid.join();
    } else {
      rgb = colorBlend(colorScale.mid, colorScale.low, (stat * 2)).join();
    }
    return rgb;
  }

  function calcColorsFromSpread (comparator, pct) {
    var rgb;
    if (comparator > 0) {
      rgb = colorBlend(colorScale.hi, colorScale.mid, pct).join();
    } else if (comparator === 0) {
      rgb = colorScale.mid.join();
    } else {
      rgb = colorBlend(colorScale.low, colorScale.mid, pct).join();
    }
    return rgb;
  }

  // arg src = data source object
  // arg data = string
  function updateCache (src, data) {
    data = JSON.parse(data);
    data.nbaAppLastCheck = new Date(dateNow).toISOString();
    fs.writeFileSync(src.urlLocal, JSON.stringify(data), 'utf-8');
  }

  // arg data = string
  function renderResult (data) {
    data = processResult(data);
    res.render('index', {
      title: 'Standings',
      stats: data //JSON.parse(data)
    });
  }

  
  // arg data = string
  function updateCacheAndRenderResult (src, data) {
    data = data || src.cachedStr;
    updateCache(src, data);
    renderResult(data);
  }
});

module.exports = router;
